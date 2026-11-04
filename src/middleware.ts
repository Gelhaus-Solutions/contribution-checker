import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

/**
 * Runs on every document response and sets the Content-Security-Policy at
 * RUNTIME (not in next.config's headers(), which are baked at build time), so
 * the directives can carry what is only known at container runtime in our
 * generic CI image (GPID_URL, CSP_EXTRA_DOMAINS, the Sentry report endpoint).
 *
 * This middleware does NOT gate auth (an earlier cookie-name edge check caused a
 * redirect loop). Protection is server-side in requireSession()/auth()
 * (src/lib/authz.ts, src/auth.ts), which resolve the GPID session.
 */
export function middleware(_request: NextRequest): NextResponse {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", buildCsp());
  const reportTo = reportToHeader();
  if (reportTo) res.headers.set("Report-To", reportTo);
  return res;
}

export const config = {
  // All document routes (not Next internals/static assets, and not /api/* which
  // returns JSON and needs no CSP) so the CSP covers every page.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
