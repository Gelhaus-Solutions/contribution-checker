import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { ServerUser } from "@hexclave/next";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  CREATE_PROJECT_PERMISSION,
  GITHUB_OAUTH_SCOPES,
  GITHUB_PROVIDER_CONFIG_ID,
  getStackServerApp,
  SUPER_ADMIN_PERMISSION,
} from "@/lib/stack";
import { isInstanceAdminTeam } from "@/lib/stack-provisioning";
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

export type OrgRoles = { isSuperAdmin: boolean; canCreateProj: boolean };

/**
 * Resolve a user's org roles (super-admin / can-create-project). Stack Auth is
 * the source of truth and the live authority is:
 *   - SUPER-ADMIN: membership in the Instance Admin team (server-trusted by the
 *     `instanceAdmin` serverMetadata marker or the STACK_INSTANCE_ADMIN_TEAM_ID
 *     env pin; see isInstanceAdminTeam), with the global `super_admin` project
 *     permission kept only as an explicit break-glass fallback.
 *   - CAN-CREATE-PROJECT: the global `create_project` permission, or implied by
 *     super-admin.
 *
 * The SUPER_ADMINS / PROJECT_CREATORS env CSVs are NO LONGER a live grant: they
 * only seed the Instance Admin team once (see bootstrapInstanceAdmins). The
 * previous client-settable team-metadata `grantedRoles` path is removed (it was
 * a privilege-escalation hole). Pure: reads only, no writes. auth() keeps the
 * local cache columns in sync from this.
 */
export async function resolveOrgRoles(
  stackUser: ServerUser,
): Promise<OrgRoles> {
  let isSuperAdmin = false;
  let canCreateProj = false;

  // Global project (break-glass) permissions.
  try {
    if (await stackUser.getPermission(SUPER_ADMIN_PERMISSION)) isSuperAdmin = true;
    if (await stackUser.getPermission(CREATE_PROJECT_PERMISSION))
      canCreateProj = true;
  } catch (e) {
    logger.warn(
      { err: e, "stack.user_id": stackUser.id },
      "auth: reading project permissions failed",
    );
  }

  // Instance Admin team membership = super-admin (the primary live authority).
  try {
    const teams = await stackUser.listTeams();
    if (teams.some((team) => isInstanceAdminTeam(team))) isSuperAdmin = true;
  } catch (e) {
    logger.warn(
      { err: e, "stack.user_id": stackUser.id },
      "auth: reading team memberships failed",
    );
  }

  // Super-admin always implies project creation.
  if (isSuperAdmin) canCreateProj = true;
  return { isSuperAdmin, canCreateProj };
}

/**
 * Resolve roles and mirror them to the local cache columns. Used by the
 * onboarding flow and the Hexclave webhook for immediacy; auth() also keeps the
 * mirror current on each request.
 */
export async function reconcileOrgPermissions(
  stackUser: ServerUser,
  localUserId: string,
): Promise<void> {
  const roles = await resolveOrgRoles(stackUser);
  await prisma.user.update({
    where: { id: localUserId },
    data: { isSuperAdmin: roles.isSuperAdmin, canCreateProj: roles.canCreateProj },
  });
}

/**
 * Capture the country code in the background (no user prompt): use Hexclave's
 * best-effort geo `countryCode` (captured from request geo headers at sign-up).
 * When it resolves to a valid ISO 3166-1 alpha-2 code, write it to Hexclave
 * clientReadOnlyMetadata (canonical) and mirror it to User.country. When geo is
 * unavailable/invalid we leave it unset rather than asking the user.
 */
export async function captureGeoCountry(
  stackUser: ServerUser,
  localUserId: string,
): Promise<string | null> {
  const code = (stackUser.countryCode ?? "").trim().toUpperCase();
  if (!isValidCountryCode(code)) return null;
  const existing =
    (stackUser.clientReadOnlyMetadata as Record<string, unknown> | null) ?? {};
  await stackUser.update({
    clientReadOnlyMetadata: { ...existing, country: code },
  });
  await prisma.user.update({
    where: { id: localUserId },
    data: { country: code },
  });
  return code;
}

/** Emit the auth.signin metric (preserved from the old NextAuth signIn event). */
export function recordSignInMetric(isNewUser: boolean): void {
  Sentry.metrics.count("auth.signin", 1, {
    attributes: { provider: "hexclave", "auth.is_new_user": isNewUser },
  });
}

/** Emit the auth.signout metric (preserved from the old NextAuth signOut event).
 * Fired from the signOut() shim, which is what the app's "Sign out" button
 * calls (the same trigger the old metric had). */
export function recordSignOutMetric(): void {
  Sentry.metrics.count("auth.signout", 1, {
    attributes: { provider: "hexclave" },
  });
}

/**
 * Grant or revoke a project-level Hexclave permission for a linked user
 * (Hexclave is the source of truth). Used by /admin/allowlist. Idempotent: only
 * writes when the desired state differs. Throws if the Hexclave user is missing.
 */
export async function setOrgPermission(
  stackUserId: string,
  permissionId: string,
  granted: boolean,
): Promise<void> {
  const stackApp = await getStackServerApp();
  const stackUser = await stackApp.getUser(stackUserId);
  if (!stackUser) {
    throw new Error(`Hexclave user not found for ${stackUserId}`);
  }
  const has = await stackUser.hasPermission(permissionId);
  if (granted && !has) await stackUser.grantPermission(permissionId);
  if (!granted && has) await stackUser.revokePermission(permissionId);
}
