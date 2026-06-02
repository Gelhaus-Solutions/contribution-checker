import "server-only";
import { cache } from "react";
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
 * on the next request, and the local cache columns are kept in sync. Wrapped in
 * React `cache()` so the (potentially several) Hexclave round-trips run once
 * per request even though auth() is called from many components.
 */
export const auth = cache(async function auth(): Promise<Session | null> {
  if (!env.stackConfigured) return null;
  try {
    const stackApp = await getStackServerApp();
    const stackUser = await stackApp.getUser();
    if (!stackUser) {
      setSentryUser(null);
      return null;
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
    const roles = await resolveOrgRoles(stackUser, u.ghLogin);
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
});

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
