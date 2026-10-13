import { NextResponse } from "next/server";
import { ciReconcileBodySchema } from "@/lib/ci/reconcile-core";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";
import { runCiReconcileWorkflow } from "@/lib/temporal/start";
import { workflowIds } from "@/lib/temporal/task-queue";
import { botStopped, presentsDecoyKey } from "@/lib/lockdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function POST(req: Request) {
  // GLockdown's honeytokens (src/lib/lockdown.ts): a decoy key tells GLockdown
  // at once, and is refused below exactly where an unknown token is.
  const decoy = presentsDecoyKey(req);
  // GLockdown's kill switch from AAL phase 2 (src/lib/lockdown.ts): the bot
  // stops, and no pull request is gated or touched while it holds.
  if (botStopped()) {
    return NextResponse.json({ error: "locked down" }, { status: 503 });
  }
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

  if (decoy) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }
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
