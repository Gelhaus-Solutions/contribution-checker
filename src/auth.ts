import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getStackServerApp } from "@/lib/stack";
import { resolveLocalUserFromStack } from "@/lib/auth/resolve-user";
import {
  captureGeoCountry,
  recordSignOutMetric,
  resolveOrgRoles,
} from "@/lib/auth/sync-user";
import { setSentryUser } from "@/lib/observability/sentry-user";
import type { Session } from "@/lib/auth-types";

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
 * on the next request, and the local cache columns are kept in sync. The
 * Hexclave SDK already dedupes getUser()/permission/team reads per request, so
 * calling auth() from many components is cheap. (Do NOT wrap this in
 * React.cache(): getUser() reads cookies(), and Next 15 throws when a dynamic
 * API is used inside a cache scope -> auth() would throw and every protected
 * page would bounce to sign-in.)
 */
export async function auth(): Promise<Session | null> {
  if (!env.stackConfigured) return null;
  try {
    const stackApp = await getStackServerApp();
    const stackUser = await stackApp.getUser({ includeRestricted: true });
    if (!stackUser) {
      setSentryUser(null);
      return null;
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
      return null;
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
      };
    }

    const u = await resolveLocalUserFromStack({
      id: stackUser.id,
      primaryEmail: stackUser.primaryEmail,
      displayName: stackUser.displayName,
      profileImageUrl: stackUser.profileImageUrl,
    });

    // Capture the country in the background (no prompt) when it's still unset:
    // a one-time, bounded write from Hexclave's geo signal. This also covers
    // backfilled users who skip /welcome (they already have ghId). It's a sync
    // no-op when geo is unavailable, so the steady state costs nothing.
    let country = u.country;
    if (!country) {
      try {
        country = await captureGeoCountry(stackUser, u.id);
      } catch (e) {
        logger.warn(
          { err: e, "stack.user_id": stackUser.id },
          "auth: geo country capture failed",
        );
      }
    }

    // Resolve org roles live, then keep the local cache columns in sync.
    const roles = await resolveOrgRoles(stackUser);
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

    setSentryUser({ id: u.id, ghLogin: u.ghLogin, email: u.email });

    return {
      user: {
        id: u.id,
        name: u.name,
        email: u.email ?? "",
        image: u.image,
        ghId: u.ghId,
        ghLogin: u.ghLogin,
        country,
        isSuperAdmin: roles.isSuperAdmin,
        canCreateProj: roles.canCreateProj,
      },
    };
  } catch (e) {
    logger.error({ err: e }, "auth: failed to resolve session");
    return null;
  }
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
