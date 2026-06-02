import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

/**
 * Two jobs, both runtime (edge-safe: no Hexclave SDK, no Vault, no DB):
 *
 * 1. Content-Security-Policy on every response. Set here, not in next.config's
 *    headers(), because connect-src must include the operator's Hexclave
 *    backend (STACK_API_URL), only known at container runtime in our generic
 *    CI-built image (next.config headers are baked at build time).
 *
 * 2. Auth gate for protected routes: fast-reject anonymous requests to
 *    /dashboard, /admin, and /welcome by checking for a Hexclave refresh-token
 *    cookie. Full session validation + the onboarding gate run server-side in
 *    requireSession() (src/lib/authz.ts).
 *
 * Hexclave refresh cookies are named `hexclave-refresh-<projectId>` /
 * `stack-refresh-<projectId>` with an optional `__Host-` prefix and structured
 * suffixes, so we match the name prefix (no projectId needed).
 */
const REFRESH_COOKIE = /^(?:__Host-)?(?:hexclave|stack)-refresh-/;
const PROTECTED = /^\/(?:dashboard|admin|welcome)(?:\/|$)/;

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Content-Security-Policy", buildCsp());
  const reportTo = reportToHeader();
  if (reportTo) res.headers.set("Report-To", reportTo);
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;

  // Auth gate (only for protected paths, and only when Hexclave is configured).
  if (PROTECTED.test(pathname) && process.env.STACK_PROJECT_ID) {
    const hasSession = req.cookies
      .getAll()
      .some((c) => REFRESH_COOKIE.test(c.name) && c.value.length > 0);
    if (!hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = "/handler/sign-in";
      url.search = "";
      url.searchParams.set("after_auth_return_to", pathname + search);
      return withSecurityHeaders(NextResponse.redirect(url));
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // All routes except Next internals/static assets, so the CSP covers every
  // document (the Hexclave client SDK is mounted app-wide via <StackProvider>).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
