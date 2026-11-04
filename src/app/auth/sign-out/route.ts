import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { recordSignOutMetric } from "@/lib/auth/sync-user";
import { getSso, SESSION_COOKIE } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign out of this app, for a form or a script that cannot call the signOut()
 * server action (the lockdown page, the header's account popup). POST only:
 * the session cookie is SameSite=Lax, so another site cannot post here with
 * it, and a link nobody meant to follow cannot sign anybody out.
 *
 * The SDK forgets its cached answer for the token too. The GPID session
 * itself is GPID's to end.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && env.gpidConfigured) {
    try {
      (await getSso()).forget(token);
    } catch (e) {
      logger.warn({ err: e }, "auth: forgetting the session token failed");
    }
  }
  recordSignOutMetric();
  // 303, so the browser follows with a GET whatever the form posted.
  const response = NextResponse.redirect(new URL("/", env.PUBLIC_BASE_URL), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
