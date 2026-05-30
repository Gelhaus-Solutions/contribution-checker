import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  decideForRepo,
  decisionRepoInclude,
  type RepoForDecision,
} from "@/lib/applications/decide-pr";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  projectSlug: z.string().min(1).max(140),
});

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
  const parsed = bodySchema.safeParse(raw);
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

  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: {
      id: true,
      name: true,
      labelsEnabled: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const repo = await prisma.repo.findUnique({
    where: {
      projectId_fullName: {
        projectId: project.id,
        fullName: claims.repository,
      },
    },
    include: decisionRepoInclude,
  });
  if (!repo || !repo.active) {
    return NextResponse.json({ error: "repo not registered" }, { status: 404 });
  }
  if (repo.installationId != null) {
    return NextResponse.json(
      { error: "repo is App-installed; CI mode disabled" },
      { status: 409 }
    );
  }

  const closed = await prisma.prCheck.findMany({
    where: { repoId: repo.id, closedByApp: true },
  });

  const reopens: Array<{
    prCheckId: string;
    prNumber: number;
    body: string;
    labels: { add: string[]; remove: string[] } | null;
  }> = [];
  for (const check of closed) {
    const decision = await decideForRepo({
      repo: repo as RepoForDecision,
      prAuthorGhLogin: check.authorGhLogin,
      prAuthorGhId: check.authorGhId,
    });
    if (decision.status !== "APPROVED" && decision.status !== "BYPASSED") {
      continue;
    }
    const labels = project.labelsEnabled
      ? {
          add: [project.labelApproved],
          remove: [project.labelPending, project.labelDenied],
        }
      : null;
    reopens.push({
      prCheckId: check.id,
      prNumber: check.prNumber,
      body: `@${check.authorGhLogin}'s application for **${project.name}** was approved. Reopening this PR.`,
      labels,
    });
  }

  return NextResponse.json({ reopens });
}
