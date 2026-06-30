import * as Sentry from "@sentry/nextjs";
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
import { verifyDco } from "@/lib/cla/dco";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import { verifyGhActionsToken } from "@/lib/ci/oidc";
import { buildDecisionCheckPayload } from "@/lib/github/check-run";
import { runQualityFromContext } from "@/lib/quality/run";
import { computeScore } from "@/lib/quality/score";
import { parseQualityConfig } from "@/lib/quality/registry";
import type { FetchedPrContext } from "@/lib/quality/fetch";

const fileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed"]),
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

export const ciCheckPrBodySchema = z.object({
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
  qualityContext: z
    .object({
      files: z.array(fileSchema).max(500).optional(),
      filesTruncated: z.boolean().optional(),
      commits: z.array(commitSchema).max(500).optional(),
      account: accountSchema.optional(),
    })
    .optional(),
});

export type CiCheckPrBody = z.infer<typeof ciCheckPrBodySchema>;
export type GhActionsClaims = Awaited<ReturnType<typeof verifyGhActionsToken>>;
export type CoreResult = { status: number; json: unknown };

/**
 * The full CI check-pr business logic, extracted verbatim from the old route so
 * it can run inside the `ciCheckPr` Temporal activity. OIDC token verification
 * and bearer parsing stay at the HTTP edge (they need the raw request); this
 * receives the already-validated body and verified claims and returns the
 * status + JSON the route relays to the Action.
 */
export async function computeCiCheckPr(input: {
  body: CiCheckPrBody;
  claims: GhActionsClaims;
}): Promise<CoreResult> {
  const { body, claims } = input;

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
      labelClaPending: true,
      checkerEnabled: true,
      trackWhenDisabled: true,
      checksEnabled: true,
      dcoEnabled: true,
      qualityEnabled: true,
      qualityConfig: true,
      qualityCommentMin: true,
      prTemplateHoneypots: true,
      qualityTemplateMatchPct: true,
    },
  });
  if (!project) return { status: 404, json: { error: "project not found" } };

  const repo = await prisma.repo.findUnique({
    where: {
      projectId_fullName: { projectId: project.id, fullName: claims.repository },
    },
    include: decisionRepoInclude,
  });
  if (!repo || !repo.active) {
    return { status: 404, json: { error: "repo not registered for this project" } };
  }
  if (repo.installationId != null) {
    return { status: 409, json: { error: "repo is App-installed; CI mode disabled" } };
  }

  if (repo.ghRepoId == null) {
    const ghRepoIdNum = Number.parseInt(claims.repository_id, 10);
    if (Number.isFinite(ghRepoIdNum)) {
      try {
        await prisma.repo.update({
          where: { id: repo.id },
          data: { ghRepoId: ghRepoIdNum },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
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
    return { status: 429, json: { error: "rate limit exceeded" } };
  }

  let decision = await decideForRepo({
    repo: repo as RepoForDecision,
    prAuthorGhLogin: body.pull_request.user.login,
    prAuthorGhId: body.pull_request.user.id,
    isCollaboratorHint: body.isCollaborator,
  });

  if (
    project.dcoEnabled &&
    (decision.status === "APPROVED" || decision.status === "BYPASSED")
  ) {
    const commits = body.qualityContext?.commits ?? [];
    if (commits.length > 0) {
      const dco = verifyDco(commits.map((c) => ({ sha: c.sha, message: c.message })));
      if (!dco.ok) {
        decision = {
          status: "CHECK_REQUIRED",
          reason: "dco_missing",
          repoId: decision.repoId,
          projectId: decision.projectId,
        };
      }
    } else {
      logger.info(
        { projectId: project.id, prNumber: body.pull_request.number },
        "DCO enabled but no commits in CI request body; skipping DCO check"
      );
    }
  }

  const decisionAttrs: Record<string, string> = { "decision.outcome": decision.status };
  if ("reason" in decision && decision.reason) {
    decisionAttrs["decision.reason"] = String(decision.reason);
  }
  if ("bypassReason" in decision && decision.bypassReason) {
    decisionAttrs["decision.bypass_reason"] = decision.bypassReason;
  }
  Sentry.metrics.count("pr.decision", 1, { attributes: { ...decisionAttrs, mode: "ci" } });

  if (decision.status === "IGNORED") {
    return { status: 422, json: { error: `ignored: ${decision.reason}` } };
  }

  const closePr = decision.status === "PENDING" || decision.status === "DENIED";
  const newStatus =
    decision.status === "APPROVED" || decision.status === "BYPASSED"
      ? "APPROVED"
      : decision.status === "DENIED"
        ? "DENIED"
        : decision.status === "CHECK_REQUIRED"
          ? "CHECK_REQUIRED"
          : "PENDING";
  const gateReason = decision.status === "CHECK_REQUIRED" ? decision.reason : null;

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
        gateReason,
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
        gateReason,
        headSha,
      },
    });
    prCheckId = prCheck.id;
  }

  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;
  const claUrl = `${applyUrl}/cla`;
  const message = buildDecisionMessage({
    decision,
    projectName: project.name,
    applyUrl,
    ghLogin: body.pull_request.user.login,
    claUrl,
  });

  let labels: { add: string[]; remove: string[] } | null = null;
  if (project.labelsEnabled) {
    if (disabledByChecker || decision.status === "APPROVED" || decision.status === "BYPASSED") {
      labels = {
        add: [project.labelApproved],
        remove: [project.labelPending, project.labelDenied],
      };
    } else if (decision.status === "PENDING") {
      labels = {
        add: [project.labelPending],
        remove: [project.labelApproved, project.labelDenied],
      };
    } else if (decision.status === "CHECK_REQUIRED") {
      labels = {
        add: [project.labelClaPending],
        remove: [project.labelApproved, project.labelPending, project.labelDenied],
      };
    } else {
      labels = {
        add: [project.labelDenied],
        remove: [project.labelApproved, project.labelPending],
      };
    }
  }

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

  const checkPayload =
    project.checksEnabled && headSha
      ? buildDecisionCheckPayload({
          decision: decision as Parameters<typeof buildDecisionCheckPayload>[0]["decision"],
          applyUrl,
          projectName: project.name,
          claUrl,
        })
      : null;

  let quality: { score: number | null; failedIds: string[]; passedIds: string[] } | null =
    null;
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
      prTemplate: null,
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
    const result = await runQualityFromContext({ prCheckId, project, fetched: ctx });
    if (result) {
      quality = {
        score: result.summary.score,
        failedIds: result.summary.failedIds,
        passedIds: result.summary.passedIds,
      };
    }
  } else if (prCheckId && project.qualityEnabled) {
    const existing = await prisma.prQuality.findUnique({
      where: { prCheckId },
      select: { signalsRaw: true },
    });
    if (existing) {
      const config = parseQualityConfig(project.qualityConfig);
      const signals = JSON.parse(existing.signalsRaw) as Record<string, { failed: boolean }>;
      const summary = computeScore(signals, config);
      quality = {
        score: summary.score,
        failedIds: summary.failedIds,
        passedIds: summary.passedIds,
      };
    }
  }

  const gated = decision.status === "CHECK_REQUIRED";

  return {
    status: 200,
    json: {
      decision: effectiveClosePr || gated ? "block" : "approve",
      closePr: effectiveClosePr,
      disabled: disabledByChecker,
      body: disabledByChecker ? null : message,
      labels,
      project: { name: project.name, slug: project.slug, applyUrl },
      check: checkPayload,
      quality,
    },
  };
}
