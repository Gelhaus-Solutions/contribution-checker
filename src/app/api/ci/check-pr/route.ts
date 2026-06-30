import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  ciCheckPrBodySchema,
} from "@/lib/ci/check-pr-core";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";
import { runCiCheckPrWorkflow } from "@/lib/temporal/start";
import { workflowIds } from "@/lib/temporal/task-queue";
import {
  BodyTooLargeError,
  readLimitedBody,
} from "@/lib/http/read-limited-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CI_BODY_BYTES = 2_097_152;

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

  let rawBody: string;
  try {
    rawBody = await readLimitedBody(req, MAX_CI_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = ciCheckPrBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  Sentry.getCurrentScope().setAttributes({
    "ci.project_slug": body.projectSlug,
    "ci.action": body.action,
    "github.pr_number": body.pull_request.number,
    "github.pr_author": body.pull_request.user.login,
  });

  // OIDC verification stays at the HTTP edge (needs the raw bearer token); the
  // decision + side effects run durably inside the workflow.
  let claims;
  try {
    claims = await verifyGhActionsToken({
      token,
      expectedAudience: expectedAudienceForProject(body.projectSlug),
    });
  } catch (e) {
    if (e instanceof OidcVerificationError) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }
    throw e;
  }

  const headSha = body.pull_request.head?.sha ?? "nosha";
  const workflowId = workflowIds.ciCheckPr(
    body.projectSlug,
    body.pull_request.number,
    headSha
  );

  const result = await runCiCheckPrWorkflow(workflowId, body, claims);
  return NextResponse.json(result.json, { status: result.status });
}
