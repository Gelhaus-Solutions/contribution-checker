import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { safeNextPath } from "@/lib/auth/next-path";

export const dynamic = "force-dynamic";

/**
 * Hexclave's old handler addresses, kept so a bookmark, an old mail or a page
 * cached before the move off Hexclave still goes somewhere: a sign-in or
 * sign-up starts GitHub's sign-in through GPID with the same return path,
 * anything else (account settings, sign-out, a callback) goes home.
 */
export function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stack: string[] }> },
): Promise<NextResponse> {
  return params.then(({ stack }) => {
    const base = env.PUBLIC_BASE_URL;
    const action = stack[0] ?? "";
    if (action === "sign-in" || action === "sign-up") {
      const back = safeNextPath(request.nextUrl.searchParams.get("after_auth_return_to"));
      const target = back ? `/auth/github?returnTo=${encodeURIComponent(back)}` : "/auth/github";
      return NextResponse.redirect(new URL(target, base));
    }
    return NextResponse.redirect(new URL("/", base));
  });
}
