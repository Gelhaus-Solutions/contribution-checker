import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

/**
 * Sets the Content-Security-Policy on every document response at RUNTIME (not
 * in next.config's headers(), which are baked at build time) so connect-src can
 * include the operator's Hexclave backend (STACK_API_URL), only known at
 * container runtime in our generic CI image.
 *
 * NOTE: this middleware does NOT gate auth. An earlier version fast-rejected
 * /dashboard and /admin by checking for a Hexclave refresh-token cookie at the
 * edge, but recognizing Hexclave's session cookie by name is unreliable
 * (structured / __Host- variants, and cross-domain setups where the app and the
 * Hexclave backend are on different domains). A mismatch caused a redirect loop
 * between /dashboard and /handler/sign-in. Protection is done server-side in
 * requireSession()/auth() (src/lib/authz.ts, src/auth.ts) using the SDK's
 * authoritative session read, which is loop-safe.
 */
export function middleware(): NextResponse {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", buildCsp());
  const reportTo = reportToHeader();
  if (reportTo) res.headers.set("Report-To", reportTo);
  return res;
}

export const config = {
  // All document routes (not Next internals/static assets, and not /api/* which
  // returns JSON and needs no CSP) so the CSP covers every page (the Hexclave
  // client SDK is mounted app-wide via <StackProvider>).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
