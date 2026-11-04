import "server-only";
import { createSsoClient, type SsoClient } from "@ghub/gpsso-sdk";
import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";

/**
 * GPlatform Identity (GPID), the only sign-in this app has since it left
 * Hexclave. Contribution Checker is enrolled there as a native product, and
 * everybody signs in with GitHub through GPID's provider flow: this server
 * starts the flow, GPID talks to GitHub, and the browser comes back to
 * `/auth/callback` with a handoff code that this server, holding the app
 * secret, exchanges for a GPID session token. The token lives in an httpOnly
 * cookie and is resolved on every request (`auth()`), cached for exactly the
 * window GPID states, so a lockdown or a revocation at GPID reaches this app
 * inside that window whether or not anything is pushed.
 *
 * The secret may live in Vault, so it is resolved through `getSecret`. Built
 * lazily and memoized, so the module can be imported at build time and in
 * tests without a configured GPID; a failed build is not memoized.
 */

/** The GPID session token. httpOnly, so no script on the page can read it. */
export const SESSION_COOKIE = "cc_session";
/** Where to land after sign-in, kept across the round trip to GitHub. */
export const RETURN_COOKIE = "cc_return_to";
/** GPID's provider slug for the family's GitHub sign-in. */
export const GITHUB_PROVIDER = "github";

let cached: Promise<SsoClient> | null = null;

export function getSso(): Promise<SsoClient> {
  if (!cached) {
    cached = (async () => {
      const appSecret = await getSecret("GPID_APP_SECRET");
      if (!env.GPID_URL || !appSecret) {
        throw new Error("GPID is not configured: GPID_URL and GPID_APP_SECRET are both required");
      }
      return createSsoClient({ baseUrl: env.GPID_URL, appSlug: env.GPID_APP_SLUG, appSecret });
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** The address GPID sends the browser back to; registered for this app at enrolment. */
export function callbackUrl(): string {
  return new URL("/auth/callback", env.PUBLIC_BASE_URL).toString();
}

/** Cookies are Secure wherever the app is served over HTTPS. */
export function secureCookies(): boolean {
  return env.PUBLIC_BASE_URL.startsWith("https://");
}
