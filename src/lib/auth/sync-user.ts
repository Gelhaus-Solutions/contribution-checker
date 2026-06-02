import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { ServerUser } from "@hexclave/next";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  CREATE_PROJECT_PERMISSION,
  GITHUB_OAUTH_SCOPES,
  GITHUB_PROVIDER_CONFIG_ID,
  SUPER_ADMIN_PERMISSION,
} from "@/lib/stack";
import { isValidCountryCode } from "@/lib/countries";

type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

/** Fetch the authenticated GitHub user via a connected-account access token.
 * This is how ghId/ghLogin are guaranteed regardless of what Hexclave surfaces. */
async function fetchGithubUser(token: string): Promise<GithubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "contribution-checker",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub /user fetch failed: ${res.status}`);
  }
  return (await res.json()) as GithubUser;
}

/** True if the Hexclave user has a GitHub OAuth provider connected. */
export function isGithubConnected(stackUser: ServerUser): boolean {
  return stackUser.oauthProviders.some(
    (p) => p.id === GITHUB_PROVIDER_CONFIG_ID,
  );
}

/**
 * Pull the GitHub identity (numeric id + login) from the connected account and
 * persist it onto the local User row.
 *
 * Handles the lazy-link merge case: if another local row already owns this
 * `ghId` (the real pre-existing account, while this session created a fresh
 * row), re-point `stackUserId` to the original row and discard the fresh,
 * relation-less row. Returns the id of the row the session should be bound to.
 */
export async function syncGitHubIdentity(
  stackUser: ServerUser,
  localUserId: string,
): Promise<{ userId: string; ghId: number; ghLogin: string }> {
  const conn = await stackUser.getOrLinkConnectedAccount(
    GITHUB_PROVIDER_CONFIG_ID,
    { scopes: GITHUB_OAUTH_SCOPES },
  );
  const tokenRes = await conn.getAccessToken({ scopes: GITHUB_OAUTH_SCOPES });
  if (tokenRes.status !== "ok") {
    throw new Error("Could not obtain a GitHub access token for the user");
  }
  const gh = await fetchGithubUser(tokenRes.data.accessToken);
  const ghId = gh.id;
  const ghLogin = gh.login;

  const owner = await prisma.user.findUnique({ where: { ghId } });
  if (owner && owner.id !== localUserId) {
    // Re-point the Hexclave link to the pre-existing GitHub-identified row and
    // drop the freshly-created session row (it has no relations yet).
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: localUserId },
        data: { stackUserId: null },
      });
      await tx.user.update({
        where: { id: owner.id },
        data: {
          stackUserId: stackUser.id,
          ghLogin,
          name: owner.name ?? gh.name,
          image: owner.image ?? gh.avatar_url,
        },
      });
      await tx.user.delete({ where: { id: localUserId } }).catch(() => {
        // Keep the row if it unexpectedly has relations; harmless, just logged.
      });
    });
    logger.warn(
      {
        "stack.user_id": stackUser.id,
        "github.id": ghId,
        "merged.from": localUserId,
        "merged.into": owner.id,
      },
      "auth: merged fresh session row into existing GitHub-identified user",
    );
    return { userId: owner.id, ghId, ghLogin };
  }

  // Normal path: write the GitHub identity onto the current row.
  try {
    await prisma.user.update({
      where: { id: localUserId },
      data: {
        ghId,
        ghLogin,
        name: gh.name ?? undefined,
        image: gh.avatar_url ?? undefined,
      },
    });
  } catch (e) {
    // P2002 on ghId/ghLogin: the GitHub identity is attached elsewhere. Surface
    // it (matches the old NextAuth signIn-event handling) but don't crash.
    logger.error(
      { err: e, "stack.user_id": stackUser.id, "github.id": ghId },
      "auth: failed to persist GitHub identity",
    );
    throw e;
  }
  return { userId: localUserId, ghId, ghLogin };
}

/**
 * Reconcile the org-level Hexclave permissions from the SUPER_ADMINS /
 * PROJECT_CREATORS env CSVs (additive promotion only, mirroring the old
 * sign-in behavior; /admin/allowlist handles revocation), then mirror the
 * effective Hexclave permission state to the local cache columns.
 *
 * Hexclave is the source of truth; the local columns are a hot-path cache read
 * by auth().
 */
export async function reconcileOrgPermissions(
  stackUser: ServerUser,
  ghLogin: string | null,
  localUserId: string,
): Promise<void> {
  const lower = (ghLogin ?? "").toLowerCase();
  const shouldBeSuper = !!lower && env.superAdmins.includes(lower);
  const shouldBeCreator =
    shouldBeSuper || (!!lower && env.projectCreators.includes(lower));

  try {
    if (shouldBeSuper && !(await stackUser.hasPermission(SUPER_ADMIN_PERMISSION))) {
      await stackUser.grantPermission(SUPER_ADMIN_PERMISSION);
    }
    if (
      shouldBeCreator &&
      !(await stackUser.hasPermission(CREATE_PROJECT_PERMISSION))
    ) {
      await stackUser.grantPermission(CREATE_PROJECT_PERMISSION);
    }
  } catch (e) {
    // Most likely the project permission isn't defined in Hexclave yet. Log and
    // continue so onboarding still completes; the operator defines the
    // permissions per /admin/setup.
    logger.error(
      { err: e, "stack.user_id": stackUser.id },
      "auth: failed to grant Hexclave permission",
    );
  }

  const [isSuper, canCreate] = await Promise.all([
    stackUser.hasPermission(SUPER_ADMIN_PERMISSION).catch(() => false),
    stackUser.hasPermission(CREATE_PROJECT_PERMISSION).catch(() => false),
  ]);
  await prisma.user.update({
    where: { id: localUserId },
    data: { isSuperAdmin: isSuper, canCreateProj: canCreate },
  });
}

/**
 * Persist the onboarding country: ISO 3166-1 alpha-2, written to Hexclave
 * clientReadOnlyMetadata (canonical, with an `onboarded` flag for the edge/UX)
 * and mirrored to User.country.
 */
export async function setOnboardingCountry(
  stackUser: ServerUser,
  localUserId: string,
  country: string,
): Promise<void> {
  const code = country.trim().toUpperCase();
  if (!isValidCountryCode(code)) {
    throw new Error("Country must be a valid ISO 3166-1 alpha-2 code");
  }
  const existing =
    (stackUser.clientReadOnlyMetadata as Record<string, unknown> | null) ?? {};
  await stackUser.update({
    clientReadOnlyMetadata: { ...existing, country: code, onboarded: true },
  });
  await prisma.user.update({
    where: { id: localUserId },
    data: { country: code },
  });
}

/** Emit the auth.signin metric (preserved from the old NextAuth signIn event). */
export function recordSignInMetric(isNewUser: boolean): void {
  Sentry.metrics.count("auth.signin", 1, {
    attributes: { provider: "hexclave", "auth.is_new_user": isNewUser },
  });
}
