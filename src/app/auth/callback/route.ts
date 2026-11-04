import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeNextPath } from "@/lib/auth/next-path";
import { recordSignInMetric } from "@/lib/auth/sync-user";
import { getSso, RETURN_COOKIE, secureCookies, SESSION_COOKIE } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where GPID sends the browser back with a handoff code. The code is exchanged
 * here, holding the app secret, so the session token never travels through a
 * query string; it goes into an httpOnly cookie that lasts as long as the GPID
 * session does.
 *
 * Every outcome other than a signed-in person lands on the home page with a
 * `signin` notice: `cancelled` (the person or GitHub said no), `confirm` (the
 * address GitHub named belongs to a G Platform account, and GPID mailed it to
 * confirm the link, so nobody is signed in yet) and `failed` for the rest.
 * The onboarding and terms gates run on the next page, as for any session.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const base = env.PUBLIC_BASE_URL;
  const notice = (kind: string) => {
    const response = NextResponse.redirect(new URL(`/?signin=${kind}`, base));
    response.cookies.delete({ name: RETURN_COOKIE, path: "/auth" });
    return response;
  };

  if (request.nextUrl.searchParams.get("error")) return notice("cancelled");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return notice("failed");

  try {
    const outcome = await (await getSso()).completeProvider(code);
    if (outcome.kind === "confirmation_required") return notice("confirm");
    if (outcome.kind !== "signed_in") return notice("failed");

    recordSignInMetric(outcome.registered);
    const returnTo = safeNextPath(request.cookies.get(RETURN_COOKIE)?.value) ?? "/dashboard";
    const response = NextResponse.redirect(new URL(returnTo, base));
    response.cookies.set(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      expires: new Date(outcome.expiresAt),
    });
    response.cookies.delete({ name: RETURN_COOKIE, path: "/auth" });
    return response;
  } catch (e) {
    logger.warn({ err: e }, "auth: completing the GitHub sign-in through GPID failed");
    return notice("failed");
  }
}
