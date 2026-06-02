import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { getStackServerApp } from "@/lib/stack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic for the sign-in loop. Reports what the SERVER sees:
 * whether Hexclave is configured, which hexclave/stack cookies reached the
 * server, and whether getStackServerApp().getUser() resolves a user. Returns
 * cookie NAMES only (no values) and no secrets. Remove once the loop is solved.
 *
 * Visit /api/debug/whoami in the same browser right after signing in.
 */
export async function GET() {
  const cookieStore = await cookies();
  const cookieNames = cookieStore
    .getAll()
    .map((c) => c.name)
    .filter((n) => /hexclave|stack/i.test(n));

  let hasUser = false;
  let userId: string | null = null;
  let primaryEmail: string | null = null;
  let error: string | null = null;

  try {
    if (env.stackConfigured) {
      const stackUser = await (await getStackServerApp()).getUser();
      hasUser = !!stackUser;
      userId = stackUser?.id ?? null;
      primaryEmail = stackUser?.primaryEmail ?? null;
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return NextResponse.json({
    stackConfigured: env.stackConfigured,
    hasStackApiUrl: !!process.env.STACK_API_URL,
    cookieNames,
    hasUser,
    userId,
    primaryEmail,
    error,
  });
}
