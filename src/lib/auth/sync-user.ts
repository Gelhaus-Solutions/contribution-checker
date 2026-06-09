import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { ServerUser } from "@hexclave/next";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  CREATE_PROJECT_PERMISSION,
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

/**
 * Fetch a GitHub account's PUBLIC profile by numeric id. Unlike `/user` (which
 * needs an authenticated token), `GET /user/{id}` resolves login/name/avatar for
 * any account with no auth. We use it so onboarding never depends on a
 * connected-account access token, which is unavailable when Hexclave's GitHub
 * provider runs on shared OAuth keys (the token call fails and onboarding would
 * otherwise throw before persisting ghId, gating the user out forever).
 *
 * A server token (GITHUB_TOKEN) is attached when present only to lift the 60/hr
 * unauthenticated rate limit; it is not required.
 */
async function fetchGithubUserById(id: number): Promise<GithubUser> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "contribution-checker",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/user/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub /user/${id} fetch failed: ${res.status}`);
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
): Promise<{ userId: string; ghId: number; ghLogin: string | null }> {
  // The GitHub numeric id comes straight from Stack's stored OAuth provider
  // link (its `accountId`). This is authoritative and needs no connected-account
  // access token, so it works even when Hexclave's GitHub provider runs on
  // shared OAuth keys (where getAccessToken is never available).
  //
  // Match on the provider `type` ("github"): the SDK's `getOAuthProvider(id)`
  // keys on the per-connection instance id, NOT the provider type, so it never
  // finds "github". listOAuthProviders() exposes `{ type, accountId }`.
  const providers = await stackUser.listOAuthProviders();
  const provider = providers.find(
    (p) => p.type === GITHUB_PROVIDER_CONFIG_ID && p.accountId,
  );
  const accountId = provider?.accountId?.trim();
  if (!accountId) {
    throw new Error(
      "GitHub OAuth provider is not linked to the Hexclave user (no accountId)",
    );
  }
  const ghId = Number(accountId);
  if (!Number.isInteger(ghId) || ghId <= 0) {
    throw new Error(`GitHub accountId is not a numeric id: ${accountId}`);
  }

  // The login + profile are public and resolved by numeric id (no token). This
  // is best-effort: if GitHub is unreachable/rate-limited we still persist ghId
  // below so the onboarding gate is satisfied, and ghLogin backfills on a later
  // sign-in (the gate keys on ghId only).
  let ghLogin: string | null = null;
  let ghName: string | null = null;
  let ghAvatar: string | null = null;
  try {
    const gh = await fetchGithubUserById(ghId);
    ghLogin = gh.login || null;
    ghName = gh.name;
    ghAvatar = gh.avatar_url;
  } catch (e) {
    logger.warn(
      { err: e, "stack.user_id": stackUser.id, "github.id": ghId },
      "auth: could not fetch GitHub profile by id; persisting ghId only",
    );
  }

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
          ...(ghLogin ? { ghLogin } : {}),
          name: owner.name ?? ghName,
          image: owner.image ?? ghAvatar,
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
    return { userId: owner.id, ghId, ghLogin: owner.ghLogin ?? ghLogin };
  }

  // Normal path: write the GitHub identity onto the current row. ghId is the
  // gating field and must persist; ghLogin is unique, so if it collides with a
  // row we did not match by ghId (e.g. a since-renamed GitHub account), fall
  // back to writing ghId alone rather than blocking the user out of the app.
  try {
    await prisma.user.update({
      where: { id: localUserId },
      data: {
        ghId,
        ...(ghLogin ? { ghLogin } : {}),
        ...(ghName ? { name: ghName } : {}),
        ...(ghAvatar ? { image: ghAvatar } : {}),
      },
    });
  } catch (e) {
    logger.warn(
      { err: e, "stack.user_id": stackUser.id, "github.id": ghId },
      "auth: persisting full GitHub identity failed; retrying with ghId only",
    );
    await prisma.user.update({
      where: { id: localUserId },
      data: { ghId },
    });
    return { userId: localUserId, ghId, ghLogin: null };
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
