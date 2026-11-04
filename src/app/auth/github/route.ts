import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeNextPath } from "@/lib/auth/next-path";
import { signInClosed } from "@/lib/lockdown";
import { callbackUrl, getSso, GITHUB_PROVIDER, RETURN_COOKIE, secureCookies } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign in with GitHub, through GPID. GPID gives this server the address to send
 * the browser to; GitHub sends it back to GPID, and GPID back to
 * `/auth/callback` with a handoff code. `returnTo` (a path on this site only)
 * is kept in a short-lived cookie for the way back.
 *
 * GLockdown's kill switch at `full`, and from AAL phase 1, closes this door:
 * the person lands on /lockdown, which says why.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const base = env.PUBLIC_BASE_URL;
  if (signInClosed()) return NextResponse.redirect(new URL("/lockdown", base));
  const returnTo = safeNextPath(request.nextUrl.searchParams.get("returnTo"));
  try {
    const { authorizeUrl } = await (await getSso()).startProviderSignIn(GITHUB_PROVIDER, callbackUrl());
    const response = NextResponse.redirect(authorizeUrl);
    if (returnTo) {
      response.cookies.set(RETURN_COOKIE, returnTo, {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: "lax",
        path: "/auth",
        maxAge: 15 * 60,
      });
    } else {
      response.cookies.delete(RETURN_COOKIE);
    }
    return response;
  } catch (e) {
    logger.error({ err: e }, "auth: starting the GitHub sign-in through GPID failed");
    return NextResponse.redirect(new URL("/?signin=unavailable", base));
  }
}
