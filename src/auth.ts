import "server-only";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getStackServerApp } from "@/lib/stack";
import { resolveLocalUserFromStack } from "@/lib/auth/resolve-user";
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
 * Org permissions (isSuperAdmin/canCreateProj) are read from the mirrored local
 * columns here (cheap); they are kept fresh by the onboarding flow and the
 * Hexclave webhook (src/lib/auth/sync-user.ts).
 */
export async function auth(): Promise<Session | null> {
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

    setSentryUser({ id: u.id, ghLogin: u.ghLogin, email: u.email });

    return {
      user: {
        id: u.id,
        name: u.name,
        email: u.email ?? "",
        image: u.image,
        ghId: u.ghId,
        ghLogin: u.ghLogin,
        country: u.country,
        isSuperAdmin: u.isSuperAdmin,
        canCreateProj: u.canCreateProj,
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
  redirect(handlerUrl("sign-out", opts?.redirectTo));
}
