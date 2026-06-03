import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

/**
 * Runs on every document response. Two jobs:
 *
 * 1. Sets the Content-Security-Policy at RUNTIME (not in next.config's
 *    headers(), which are baked at build time) so connect-src can include the
 *    operator's Hexclave backend (STACK_API_URL), only known at container
 *    runtime in our generic CI image.
 *
 * 2. IMPERSONATION SHIM. The Hexclave admin dashboard impersonates a user by
 *    setting a LEGACY `stack-refresh-<projectId>` cookie and reloading. But
 *    @hexclave/next reads the refresh token in priority order and the admin's
 *    own PRIMARY cookie `hexclave-refresh-<projectId>` (`--default`, `__Host-`
 *    on HTTPS) is read BEFORE the legacy one, so it shadows the impersonation
 *    token and nothing changes. When a request carries the legacy cookie we
 *    strip the primary/structured Hexclave session cookies from the request
 *    `cookie` header so the SDK's server-side cookies() read falls through to
 *    the impersonation token. This only ever fires for a deliberately pasted
 *    impersonation cookie (the SDK never writes a bare `stack-refresh-<pid>`),
 *    so normal sessions are untouched. Clearing the `stack-refresh-<pid>` cookie
 *    (the dashboard's "stop impersonating") makes the branch stop firing and the
 *    admin's own session is seen again.
 *
 * This middleware does NOT gate auth (an earlier cookie-name edge check caused a
 * redirect loop). Protection is server-side in requireSession()/auth()
 * (src/lib/authz.ts, src/auth.ts) using the SDK's authoritative session read.
 */
export function middleware(request: NextRequest): NextResponse {
  const cookieHeader = request.headers.get("cookie");

  if (cookieHeader && hasLegacyImpersonationCookie(cookieHeader)) {
    const kept = cookieHeader
      .split(/;\s*/)
      .filter((pair) => {
        const eq = pair.indexOf("=");
        const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
        return name.length > 0 && !isShadowingSessionCookie(name);
      })
      .join("; ");

    const requestHeaders = new Headers(request.headers);
    if (kept) requestHeaders.set("cookie", kept);
    else requestHeaders.delete("cookie");

    return withSecurityHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
    );
  }

  return withSecurityHeaders(NextResponse.next());
}

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", buildCsp());
  const reportTo = reportToHeader();
  if (reportTo) res.headers.set("Report-To", reportTo);
  return res;
}

/**
 * True when the cookie header carries a legacy refresh cookie the SDK treats as
 * an impersonation token: `stack-refresh-<projectId>` or the bare `stack-refresh`
 * (matches @hexclave/next `_getRefreshTokenCookieNamePatterns().legacyNames`).
 */
function hasLegacyImpersonationCookie(cookieHeader: string): boolean {
  const projectId = process.env.STACK_PROJECT_ID;
  const names = projectId
    ? [`stack-refresh-${projectId}`, "stack-refresh"]
    : ["stack-refresh"];
  return names.some((name) =>
    new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=`).test(cookieHeader),
  );
}

/**
 * True for PRIMARY/structured Hexclave session cookies that must be hidden so
 * they don't shadow the legacy impersonation cookie. We KEEP all `stack-refresh*`
 * (the legacy impersonation refresh itself); we drop the `hexclave-*` primary
 * cookies (incl. `__Host-` and `--default`/`--custom-*` structured variants) and
 * the legacy access cookie (which can pin the SDK to the admin's access token).
 */
function isShadowingSessionCookie(name: string): boolean {
  if (name.startsWith("stack-refresh")) return false;
  if (name.startsWith("hexclave-refresh")) return true;
  if (name.startsWith("__Host-hexclave-refresh")) return true;
  if (name.startsWith("hexclave-access")) return true;
  if (name.startsWith("__Host-hexclave-access")) return true;
  if (name.startsWith("stack-access")) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const config = {
  // All document routes (not Next internals/static assets, and not /api/* which
  // returns JSON and needs no CSP) so the CSP covers every page (the Hexclave
  // client SDK is mounted app-wide via <StackProvider>).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
