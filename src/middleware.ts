import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge auth gate. Fast-rejects anonymous requests to protected routes before
 * they hit a page, by checking for the presence of a Hexclave refresh-token
 * cookie.
 *
 * This is intentionally a presence check only (edge-safe: no Hexclave SDK, no
 * Vault, no DB). Full session validation and the onboarding gate (GitHub link
 * + country) run server-side in `requireSession()` (src/lib/authz.ts), which
 * has DB and Hexclave access.
 *
 * Hexclave refresh cookies are named `hexclave-refresh-<projectId>` /
 * `stack-refresh-<projectId>` with an optional `__Host-` prefix and
 * `--default` / `--custom-*` structured suffixes. We match the name prefix
 * directly (no projectId needed), so this works with runtime-supplied config in
 * a generic CI-built image (nothing is inlined at build time). STACK_PROJECT_ID
 * is read only as a runtime "is Hexclave configured?" signal; it is NOT
 * NEXT_PUBLIC_, so it is read at runtime, never inlined.
 */
const REFRESH_COOKIE = /^(?:__Host-)?(?:hexclave|stack)-refresh-/;

export function middleware(req: NextRequest): NextResponse {
  // Not configured (e.g. local dev / build): don't gate; pages still call
  // requireSession.
  if (!process.env.STACK_PROJECT_ID) return NextResponse.next();

  const hasSession = req.cookies
    .getAll()
    .some((c) => REFRESH_COOKIE.test(c.name) && c.value.length > 0);
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  const returnTo = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/handler/sign-in";
  url.search = "";
  url.searchParams.set("after_auth_return_to", returnTo);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/welcome"],
};
