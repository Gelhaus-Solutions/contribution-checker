import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildAccountExport } from "@/lib/account-export";
import { recordAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/export
 *
 * Self-service data export (GDPR Art. 15 and 20): everything the app holds
 * about the signed-in user, as one JSON attachment. Only ever the caller's own
 * data: the user id comes from the session, never from the request.
 *
 * An admin-restricted account is still served. Access to one's own data is a
 * right, not a feature the restriction switches off. No ghId or terms gate for
 * the same reason.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const limited = await rateLimit({
    key: `account-export:user:${userId}`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!limited.ok) {
    const retryAfter = Math.max(
      1,
      Math.ceil((limited.resetAt.getTime() - Date.now()) / 1000),
    );
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
      },
    );
  }

  const data = await buildAccountExport(userId);
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordAudit({
    projectId: null,
    actorId: userId,
    kind: "account.exported",
    payload: {
      applications: data.applications.length,
      claSignatures: data.cla.signatures.length,
      prChecks: data.prChecks.length,
    },
  });

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="contribution-checker-export.json"',
      "Cache-Control": "no-store",
    },
  });
}
