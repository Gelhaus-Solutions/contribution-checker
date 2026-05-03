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
import { buildDecisionCheckPayload } from "@/lib/github/check-run";
import { runQualityFromContext } from "@/lib/quality/run";
import { computeScore } from "@/lib/quality/score";
import { parseQualityConfig } from "@/lib/quality/registry";
import type { FetchedPrContext } from "@/lib/quality/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fileSchema = z.object({
  filename: z.string(),
  status: z.enum([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
  ]),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  changes: z.number().int().nonnegative().default(0),
  patch: z.string().nullable().optional(),
  previous_filename: z.string().optional(),
});

const commitSchema = z.object({
  sha: z.string(),
  message: z.string().default(""),
  authorLogin: z.string().optional(),
  authorEmail: z.string().optional(),
  committerEmail: z.string().optional(),
});

const accountSchema = z.object({
  login: z.string(),
  createdAt: z.string().optional(),
  publicRepos: z.number().int().nonnegative().optional(),
  followers: z.number().int().nonnegative().optional(),
  bio: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  hasAvatar: z.boolean().optional(),
});

const bodySchema = z.object({
  projectSlug: z.string().min(1).max(140),
  action: z.enum(["opened", "reopened", "ready_for_review", "synchronize"]),
  pull_request: z.object({
    number: z.number().int().positive(),
    node_id: z.string().min(1),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    head: z.object({ sha: z.string() }).optional(),
    user: z.object({
      login: z.string().min(1),
      id: z.number().int().positive(),
      type: z.string().optional(),
    }),
  }),
  isCollaborator: z.boolean().optional(),
  // Optional pre-fetched context for quality scoring. The Actions workflow
  // calls `gh api` with its GITHUB_TOKEN to gather this and includes it in
  // the body. When absent, quality scoring is skipped for this request.
  qualityContext: z
    .object({
      files: z.array(fileSchema).max(500).optional(),
      filesTruncated: z.boolean().optional(),
      commits: z.array(commitSchema).max(500).optional(),
      account: accountSchema.optional(),
    })
    .optional(),
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
      checkerEnabled: true,
      trackWhenDisabled: true,
      checksEnabled: true,
      qualityEnabled: true,
      qualityConfig: true,
      qualityCommentMin: true,
      prTemplateHoneypots: true,
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

  const disabledByChecker =
    decision.status === "APPROVED" &&
    "bypassReason" in decision &&
    decision.bypassReason === "checker_disabled";
  const shouldTrackPr = !disabledByChecker || project.trackWhenDisabled;
  const headSha = body.pull_request.head?.sha ?? null;

  let prCheckId: string | null = null;
  if (shouldTrackPr) {
    const prCheck = await prisma.prCheck.upsert({
      where: {
        repoId_prNumber: { repoId: repo.id, prNumber: body.pull_request.number },
      },
      update: {
        prNodeId: body.pull_request.node_id,
        authorGhLogin: body.pull_request.user.login,
        authorGhId: body.pull_request.user.id,
        status: newStatus,
        closedByApp: closePr,
        ...(headSha ? { headSha } : {}),
      },
      create: {
        repoId: repo.id,
        prNumber: body.pull_request.number,
        prNodeId: body.pull_request.node_id,
        authorGhLogin: body.pull_request.user.login,
        authorGhId: body.pull_request.user.id,
        status: newStatus,
        closedByApp: closePr,
        headSha,
      },
    });
    prCheckId = prCheck.id;
  }

  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;
  const message = buildDecisionMessage({
    decision,
    projectName: project.name,
    applyUrl,
    ghLogin: body.pull_request.user.login,
  });

  let labels: { add: string[]; remove: string[] } | null = null;
  if (project.labelsEnabled) {
    if (disabledByChecker) {
      // When the checker is disabled, only the approved label is applied.
      labels = {
        add: [project.labelApproved],
        remove: [project.labelPending, project.labelDenied],
      };
    } else if (decision.status === "APPROVED" || decision.status === "BYPASSED") {
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

  // Disable switch overrides closing — the workflow should NOT close the PR
  // when the checker is off, even if the underlying decision would have.
  const effectiveClosePr = closePr && !disabledByChecker;

  if (effectiveClosePr) {
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

  // Build the Check Run payload the workflow should publish via gh api.
  // Skipped when the project has checks disabled. (decision.status is never
  // IGNORED here — that path returns early above.)
  const checkPayload =
    project.checksEnabled && headSha
      ? buildDecisionCheckPayload({
          decision: decision as Parameters<typeof buildDecisionCheckPayload>[0]["decision"],
          applyUrl,
          projectName: project.name,
        })
      : null;

  // Run quality scoring if the workflow provided a context payload.
  let quality: {
    score: number | null;
    failedIds: string[];
    passedIds: string[];
  } | null = null;
  if (
    prCheckId &&
    project.qualityEnabled &&
    body.qualityContext &&
    body.pull_request.head?.sha
  ) {
    const ctx: FetchedPrContext = {
      pr: {
        number: body.pull_request.number,
        title: body.pull_request.title ?? "",
        body: body.pull_request.body ?? null,
        headSha: body.pull_request.head.sha,
        authorLogin: body.pull_request.user.login,
      },
      files: (body.qualityContext.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch ?? null,
        previous_filename: f.previous_filename,
      })),
      filesTruncated: body.qualityContext.filesTruncated ?? false,
      commits: body.qualityContext.commits ?? [],
      account: body.qualityContext.account ?? { login: body.pull_request.user.login },
    };
    const result = await runQualityFromContext({
      prCheckId,
      project,
      fetched: ctx,
    });
    if (result) {
      quality = {
        score: result.summary.score,
        failedIds: result.summary.failedIds,
        passedIds: result.summary.passedIds,
      };
    }
  } else if (prCheckId && project.qualityEnabled) {
    // Quality enabled but no context provided — surface what we have on
    // record so the workflow doesn't think we ran a fresh evaluation.
    const existing = await prisma.prQuality.findUnique({
      where: { prCheckId },
      select: { signalsRaw: true },
    });
    if (existing) {
      const config = parseQualityConfig(project.qualityConfig);
      const signals = JSON.parse(existing.signalsRaw) as Record<
        string,
        { failed: boolean }
      >;
      const summary = computeScore(signals, config);
      quality = {
        score: summary.score,
        failedIds: summary.failedIds,
        passedIds: summary.passedIds,
      };
    }
  }

  return NextResponse.json({
    decision: effectiveClosePr ? "block" : "approve",
    closePr: effectiveClosePr,
    disabled: disabledByChecker,
    body: disabledByChecker ? null : message,
    labels,
    project: { name: project.name, slug: project.slug, applyUrl },
    check: checkPayload,
    quality,
  });
}
