import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getStackServerApp } from "@/lib/stack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic for the sign-in loop. Compares raw getUser() with the
 * full auth() result, and shows how the Hexclave user maps to local User rows
 * (the loop is most likely auth() returning null/ghId-less, or a mislinked
 * row). No secrets / no cookie values. Remove once solved.
 */
export async function GET() {
  const cookieStore = await cookies();
  const cookieNames = cookieStore
    .getAll()
    .map((c) => c.name)
    .filter((n) => /hexclave|stack/i.test(n));

  // 1. Raw getUser (works per the previous test).
  let stackUserId: string | null = null;
  let primaryEmail: string | null = null;
  let getUserError: string | null = null;
  try {
    if (env.stackConfigured) {
      const su = await (await getStackServerApp()).getUser();
      stackUserId = su?.id ?? null;
      primaryEmail = su?.primaryEmail ?? null;
    }
  } catch (e) {
    getUserError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  // 2. The full auth() the pages actually use (this is what /dashboard checks).
  let sessionUser: unknown = null;
  let authError: string | null = null;
  try {
    const session = await auth();
    sessionUser = session?.user
      ? {
          id: session.user.id,
          ghId: session.user.ghId,
          ghLogin: session.user.ghLogin,
          isSuperAdmin: session.user.isSuperAdmin,
          canCreateProj: session.user.canCreateProj,
        }
      : null;
  } catch (e) {
    authError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  // 3. Local linkage.
  const byStackId = stackUserId
    ? await prisma.user.findMany({
        where: { stackUserId },
        select: { id: true, ghId: true, ghLogin: true, email: true },
      })
    : [];
  const byEmail = primaryEmail
    ? await prisma.user.findMany({
        where: { email: primaryEmail },
        select: { id: true, ghId: true, ghLogin: true, stackUserId: true },
      })
    : [];

  return NextResponse.json({
    stackConfigured: env.stackConfigured,
    cookieNames,
    stackUserId,
    primaryEmail,
    getUserError,
    sessionUser, // null here = auth() returned null (its catch swallowed a throw)
    authError, // populated only if auth() threw OUT (shouldn't; it catches)
    localRowsLinkedToThisStackUser: byStackId,
    localRowsWithThisEmail: byEmail,
  });
}
