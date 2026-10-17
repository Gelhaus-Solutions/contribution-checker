import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getStackServerApp } from "@/lib/stack";
import { resolveLocalUserFromStack } from "@/lib/auth/resolve-user";
import {
  clearGeoCountry,
  recordSignOutMetric,
  resolveOrgRoles,
} from "@/lib/auth/sync-user";
import { setSentryUser } from "@/lib/observability/sentry-user";
import type { Session, SessionUser } from "@/lib/auth-types";
import { standingOf } from "@/lib/gpterms";
import { isDecoyLogin, lockdown } from "@/lib/lockdown";

export type { Session } from "@/lib/auth-types";

/**
 * Drop-in replacement for the old NextAuth `auth()`.
 *
 * Reads the Hexclave (Stack Auth) cookie session, resolves it to the local
 * `User` row, and returns the SAME `{ user: {...} }` shape the rest of the app
 * already consumes. Returns null when there is no session or Hexclave is not
 * configured (keeps build/test and unconfigured deploys safe).
 *
 * Org roles (isSuperAdmin/canCreateProj) are resolved LIVE from Hexclave each
 * request (env CSV + project permissions + team metadata + whitelisted-team
 * team permissions; see resolveOrgRoles) so team-membership changes take effect
 * on the next request, and the local cache columns are kept in sync.
 *
 * Memoized per request with React `cache()`, because auth() is called several
 * times on a single page (root layout, SiteHeader, requireSession, then again
 * by requireProjectRole in the page) and each call otherwise re-ran the local
 * user lookup, the country capture and the role mirror write. The Hexclave SDK
 * only holds its own reads for ~5s, so the round-trips repeated too.
 *
 * `cookies()` inside a `cache()` scope is fine: Next only rejects it under
 * `"use cache"` / `unstable_cache(...)`, which is a different scope type. An
 * earlier cache() wrapper was removed for supposedly causing a sign-in loop; if
 * a runtime ever does refuse the memo, the wrapper below falls back to
 * resolving directly rather than reporting the request as signed out.
 *
 * Besides the session it says whether GLockdown's kill switch is why there is
 * none (`lockedOut`), so `requireSession()` can send that person to /lockdown
 * rather than to a sign-in page that would only refuse them again.
 */
interface Resolved {
  session: Session | null;
  lockedOut: boolean;
}

const SIGNED_OUT: Resolved = { session: null, lockedOut: false };
const LOCKED_OUT: Resolved = { session: null, lockedOut: true };

async function resolveSession(): Promise<Resolved> {
  if (!env.stackConfigured) return SIGNED_OUT;
  // GLockdown's kill switch (src/lib/lockdown.ts): at `full`, and from AAL
  // phase 1 whatever the stage, nobody is signed in, existing sessions
  // included.
  const { stage, refusesEveryCredential } = lockdown();
  if (stage === "full" || refusesEveryCredential) {
    setSentryUser(null);
    return LOCKED_OUT;
  }
  try {
    const stackApp = await getStackServerApp();
    const stackUser = await stackApp.getUser({ includeRestricted: true });
    if (!stackUser) {
      setSentryUser(null);
      return SIGNED_OUT;
    }
    // GLockdown's honeytokens (L97): a session as the decoy admin is refused
    // before anything is looked up, linked or created for it, exactly as no
    // session at all, and GLockdown is told. Nobody signs in as the decoy.
    if (isDecoyLogin(stackUser.primaryEmail, `Hexclave user ${stackUser.id}`)) {
      setSentryUser(null);
      return SIGNED_OUT;
    }
    // From `signups` no new account: an account this app has not seen yet is
    // not created, and the person is not signed in.
    if (stage !== "off" && !(await knownAccount(stackUser))) {
      setSentryUser(null);
      return LOCKED_OUT;
    }

    // Restriction handling. includeRestricted:true surfaces users the SDK would
    // otherwise hide (it filters restricted users out by default). Preserve that
    // behavior for onboarding restriction states (anonymous / email_not_verified)
    // by returning null, so requireSession() bounces them to sign-in exactly as
    // before. ONLY admin restrictions get the dedicated /restricted treatment.
    const restrictedByAdmin =
      stackUser.restrictedByAdmin === true ||
      stackUser.restrictedReason?.type === "restricted_by_administrator";
    if (stackUser.isRestricted && !restrictedByAdmin) {
      setSentryUser(null);
      return SIGNED_OUT;
    }
    if (restrictedByAdmin) {
      // Minimal flagged session: skip the local-user resolve, country capture,
      // and org-role round-trips. Force privileges off so even a restricted
      // super-admin cannot act. requireSession() reads `.restricted` and
      // redirects to /restricted before any privileged work runs.
      setSentryUser({
        id: stackUser.id,
        ghLogin: null,
        email: stackUser.primaryEmail,
      });
      return {
        lockedOut: false,
        session: {
          user: {
            id: stackUser.id,
            name: stackUser.displayName,
            email: stackUser.primaryEmail ?? "",
            image: stackUser.profileImageUrl,
            ghId: null,
            ghLogin: null,
            country: null,
            isSuperAdmin: false,
            canCreateProj: false,
            restricted: true,
            restrictionReason: stackUser.restrictedByAdminReason,
          },
        },
      };
    }

    const u = await resolveLocalUserFromStack({
      id: stackUser.id,
      primaryEmail: stackUser.primaryEmail,
      displayName: stackUser.displayName,
      profileImageUrl: stackUser.profileImageUrl,
    });
    // The decoy's GitHub login too, which only the local row knows. An
    // intruder who registered that login on GitHub presents it here.
    if (isDecoyLogin(u.ghLogin, `Hexclave user ${stackUser.id}`)) {
      setSentryUser(null);
      return SIGNED_OUT;
    }

    // Country is no longer captured. Any code the old capture left in Hexclave
    // metadata is removed on the user's next request: one bounded write, then
    // a no-op.
    try {
      await clearGeoCountry(stackUser);
    } catch (e) {
      logger.warn(
        { err: e, "stack.user_id": stackUser.id },
        "auth: clearing the old geo country failed",
      );
    }

    // Resolve org roles live, then keep the local cache columns in sync. The
    // terms standing is read beside it rather than after it.
    const [roles, terms] = await Promise.all([resolveOrgRoles(stackUser), termsOf(u)]);
    if (
      roles.isSuperAdmin !== u.isSuperAdmin ||
      roles.canCreateProj !== u.canCreateProj
    ) {
      await prisma.user
        .update({
          where: { id: u.id },
          data: {
            isSuperAdmin: roles.isSuperAdmin,
            canCreateProj: roles.canCreateProj,
          },
        })
        .catch((e) =>
          logger.warn(
            { err: e, "auth.user_id": u.id },
            "auth: mirroring org roles failed",
          ),
        );
    }

    // `admins`: only super-admins. `members`: super-admins and project members.
    if (stage === "admins" && !roles.isSuperAdmin) {
      setSentryUser(null);
      return LOCKED_OUT;
    }
    if (
      stage === "members" &&
      !roles.isSuperAdmin &&
      (await prisma.projectMember.count({ where: { userId: u.id } })) === 0
    ) {
      setSentryUser(null);
      return LOCKED_OUT;
    }

    setSentryUser({ id: u.id, ghLogin: u.ghLogin, email: u.email });

    return {
      lockedOut: false,
      session: {
        user: {
          id: u.id,
          name: u.name,
          email: u.email ?? "",
          image: u.image,
          ghId: u.ghId,
          ghLogin: u.ghLogin,
          country: null,
          isSuperAdmin: roles.isSuperAdmin,
          canCreateProj: roles.canCreateProj,
          // Verified for the address this session carries, not merely for
          // some address: the local row's email is what the app shows and
          // reports.
          emailVerified:
            stackUser.primaryEmailVerified === true &&
            !!u.email &&
            u.email.trim().toLowerCase() ===
              (stackUser.primaryEmail ?? "").trim().toLowerCase(),
          terms,
        },
      },
    };
  } catch (e) {
    logger.error({ err: e }, "auth: failed to resolve session");
    return SIGNED_OUT;
  }
}

/**
 * Whether this app has an account for the Hexclave user already, by its
 * Hexclave id or, for an account from before the migration, its address: what
 * `resolveLocalUserFromStack` would link instead of creating.
 */
async function knownAccount(stackUser: {
  id: string;
  primaryEmail: string | null;
}): Promise<boolean> {
  const byId = await prisma.user.findUnique({
    where: { stackUserId: stackUser.id },
    select: { id: true },
  });
  if (byId) return true;
  const email = stackUser.primaryEmail?.trim();
  if (!email) return false;
  return !!(await prisma.user.findUnique({ where: { email }, select: { id: true } }));
}

/**
 * Where an account stands with the terms: asked of GPlatform Terms where it is
 * used, weighed against every acceptance recorded here (src/lib/gpterms.ts).
 * Undefined when the step is off, and when the read fails: the standing gates
 * writes, and a failed read must not stop a signed-in person from reading.
 */
async function termsOf(u: { id: string; createdAt: Date }): Promise<SessionUser["terms"]> {
  if (env.termsAcceptStep !== "on") return undefined;
  try {
    const standing = await standingOf(u);
    return {
      kind: standing.kind,
      inForceFrom: standing.inForceFrom?.toISOString() ?? null,
      record: standing.record,
    };
  } catch (e) {
    logger.warn({ err: e, "auth.user_id": u.id }, "auth: reading the terms standing failed");
    return undefined;
  }
}

const memoizedSession = cache(resolveSession);

async function resolved(): Promise<Resolved> {
  try {
    return await memoizedSession();
  } catch (e) {
    // resolveSession swallows its own failures, so reaching here means the
    // memo itself refused (no cache scope available in this runtime). Resolve
    // uncached rather than returning null: a null here reads as "signed out"
    // and would bounce every signed-in user to /handler/sign-in.
    logger.warn({ err: e }, "auth: session memo unavailable, resolving direct");
    return resolveSession();
  }
}

export async function auth(): Promise<Session | null> {
  return (await resolved()).session;
}

/**
 * Whether GLockdown's kill switch is why this request has no session: a
 * signed-in person the stage refuses, or everyone at `full`. Read from the same
 * memoized resolve as `auth()`, so it costs nothing after it.
 */
export async function lockedOut(): Promise<boolean> {
  return (await resolved()).lockedOut;
}

function handlerUrl(action: "sign-in" | "sign-out", returnTo?: string): string {
  const base = `/handler/${action}`;
  return returnTo
    ? `${base}?after_auth_return_to=${encodeURIComponent(returnTo)}`
    : base;
}

/**
 * Sign-in shim. The `provider` argument is accepted for call-site
 * compatibility but ignored: Hexclave renders its own login form (GitHub plus
 * whatever the operator enabled). Redirects to the Hexclave handler, preserving
 * the post-auth return path used by the apply/CLA flows.
 */
export async function signIn(
  _provider?: string,
  opts?: { redirectTo?: string },
): Promise<void> {
  redirect(handlerUrl("sign-in", opts?.redirectTo));
}

export async function signOut(opts?: { redirectTo?: string }): Promise<void> {
  // Fired here (the app's "Sign out" button calls this shim) since Hexclave has
  // no server-side sign-out hook in our app. Emit before the redirect throws.
  recordSignOutMetric();
  setSentryUser(null);
  redirect(handlerUrl("sign-out", opts?.redirectTo));
}
