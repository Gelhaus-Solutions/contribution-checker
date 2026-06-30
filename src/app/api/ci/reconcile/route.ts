import { NextResponse } from "next/server";
import { ciReconcileBodySchema } from "@/lib/ci/reconcile-core";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";
import { runCiReconcileWorkflow } from "@/lib/temporal/start";
import { workflowIds } from "@/lib/temporal/task-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function POST(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = ciReconcileBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { projectSlug } = parsed.data;

  let claims;
  try {
    claims = await verifyGhActionsToken({
      token,
      expectedAudience: expectedAudienceForProject(projectSlug),
    });
  } catch (e) {
    if (e instanceof OidcVerificationError) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }
    throw e;
  }

  const workflowId = workflowIds.ciReconcile(projectSlug, claims.repository);
  const result = await runCiReconcileWorkflow(workflowId, parsed.data, claims);
  return NextResponse.json(result.json, { status: result.status });
}
