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
 * `stack-refresh-<projectId>` with optional `__Host-` prefix and `--default` /
 * `--custom-*` structured suffixes, so we match any cookie whose name contains
 * `refresh-<projectId>`.
 */
export function middleware(req: NextRequest): NextResponse {
  const projectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID;
  // Not configured (e.g. local/build): don't gate; pages still call requireSession.
  if (!projectId) return NextResponse.next();

  const marker = `refresh-${projectId}`;
  const hasSession = req.cookies
    .getAll()
    .some((c) => c.name.includes(marker) && c.value.length > 0);
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  const returnTo = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/handler/sign-in";
  url.search = "";
  url.searchParams.set("after_auth_return_to", returnTo);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
