import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/ratelimit";
import {
  decideForRepo,
  decisionRepoInclude,
  type RepoForDecision,
} from "@/lib/applications/decide-pr";
import { buildDecisionMessage } from "@/lib/applications/decision-message";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  projectSlug: z.string().min(1).max(140),
  action: z.enum(["opened", "reopened", "ready_for_review", "synchronize"]),
  pull_request: z.object({
    number: z.number().int().positive(),
    node_id: z.string().min(1),
    user: z.object({
      login: z.string().min(1),
      id: z.number().int().positive(),
      type: z.string().optional(),
    }),
  }),
  isCollaborator: z.boolean().optional(),
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
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

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

  const project = await prisma.project.findUnique({
    where: { slug: body.projectSlug },
    select: {
      id: true,
      slug: true,
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
    return NextResponse.json(
      { error: "repo not registered for this project" },
      { status: 404 }
    );
  }
  if (repo.installationId != null) {
    return NextResponse.json(
      { error: "repo is App-installed; CI mode disabled" },
      { status: 409 }
    );
  }

  // Opportunistically backfill ghRepoId from the OIDC claim. Race-safe.
  if (repo.ghRepoId == null) {
    const ghRepoIdNum = Number.parseInt(claims.repository_id, 10);
    if (Number.isFinite(ghRepoIdNum)) {
      try {
        await prisma.repo.update({
          where: { id: repo.id },
          data: { ghRepoId: ghRepoIdNum },
        });
      } catch (e) {
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
        ) {
          logger.warn({ err: e, repoId: repo.id }, "ghRepoId backfill failed");
        }
      }
    }
  }

  const rl = await rateLimit({
    key: `ci:check-pr:${repo.id}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  const decision = await decideForRepo({
    repo: repo as RepoForDecision,
    prAuthorGhLogin: body.pull_request.user.login,
    prAuthorGhId: body.pull_request.user.id,
    isCollaboratorHint: body.isCollaborator,
  });

  if (decision.status === "IGNORED") {
    return NextResponse.json(
      { error: `ignored: ${decision.reason}` },
      { status: 422 }
    );
  }

  const closePr =
    decision.status === "PENDING" || decision.status === "DENIED";
  const newStatus =
    decision.status === "APPROVED" || decision.status === "BYPASSED"
      ? "APPROVED"
      : decision.status === "DENIED"
        ? "DENIED"
        : "PENDING";

  await prisma.prCheck.upsert({
    where: {
      repoId_prNumber: { repoId: repo.id, prNumber: body.pull_request.number },
    },
    update: {
      prNodeId: body.pull_request.node_id,
      authorGhLogin: body.pull_request.user.login,
      authorGhId: body.pull_request.user.id,
      status: newStatus,
      closedByApp: closePr,
    },
    create: {
      repoId: repo.id,
      prNumber: body.pull_request.number,
      prNodeId: body.pull_request.node_id,
      authorGhLogin: body.pull_request.user.login,
      authorGhId: body.pull_request.user.id,
      status: newStatus,
      closedByApp: closePr,
    },
  });

  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;
  const message = buildDecisionMessage({
    decision,
    projectName: project.name,
    applyUrl,
    ghLogin: body.pull_request.user.login,
  });

  let labels: { add: string[]; remove: string[] } | null = null;
  if (project.labelsEnabled) {
    if (decision.status === "APPROVED" || decision.status === "BYPASSED") {
      labels = {
        add: [project.labelApproved],
        remove: [project.labelPending, project.labelDenied],
      };
    } else if (decision.status === "PENDING") {
      labels = {
        add: [project.labelPending],
        remove: [project.labelApproved, project.labelDenied],
      };
    } else {
      labels = {
        add: [project.labelDenied],
        remove: [project.labelApproved, project.labelPending],
      };
    }
  }

  if (closePr) {
    await enqueueProjectWebhook({
      projectId: project.id,
      event: "pr.blocked",
      payload: {
        repo: claims.repository,
        prNumber: body.pull_request.number,
        ghLogin: body.pull_request.user.login,
        reason: decision.status === "PENDING" ? "no-application" : "denied",
      },
    });
  }

  return NextResponse.json({
    decision: closePr ? "block" : "approve",
    closePr,
    body: message,
    labels,
    project: { name: project.name, slug: project.slug, applyUrl },
  });
}
