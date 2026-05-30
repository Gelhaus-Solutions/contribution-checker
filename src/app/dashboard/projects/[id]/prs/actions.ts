"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { runQualityForPrCheck } from "@/lib/quality/run";
import { computeScore } from "@/lib/quality/score";
import {
  ALL_HEURISTICS,
  isHeuristicEnabled,
  parseQualityConfig,
} from "@/lib/quality/registry";
import type { HeuristicResult, SignalsRaw } from "@/lib/quality/types";
import { decideForPR, type PrDecision } from "@/lib/applications/decide-pr";
import { addLabel, ensureLabel, repoRef } from "@/lib/github/pr-actions";

export type PrOverviewHeuristic = {
  id: string;
  label: string;
  group: string;
  weight: number;
  enabled: boolean;
  ran: boolean;
  failed: boolean;
  reason?: string;
  value?: number | string | null;
};

export type PrOverview = {
  id: string;
  repoFullName: string;
  repoId: string;
  prNumber: number;
  prNodeId: string;
  authorGhLogin: string;
  authorGhId: number;
  status: "PENDING" | "APPROVED" | "DENIED" | "BYPASSED";
  closedByApp: boolean;
  headSha: string | null;
  checkRunId: string | null;
  createdAt: string;
  updatedAt: string;
  ghUrl: string;
  // Mode info: drives whether re-evaluate / rescan are available.
  mode: "app" | "ci";
  installationId: number | null;
  // Project flags surfaced in the dialog.
  checkerEnabled: boolean;
  qualityEnabled: boolean;
  evaluateLabel: string;
  // Quality breakdown (null when feature off or no PrQuality row).
  quality: {
    score: number | null;
    failedCount: number;
    totalRan: number;
    computedAt: string;
    heuristics: PrOverviewHeuristic[];
    files: number;
    filesTruncated: boolean;
    commits: number;
  } | null;
  // Author-scoped PR counts (across this project).
  authorStats: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
    bypassed: number;
    closedByApp: number;
  };
  // What the decision pipeline would return *right now* for this PR's author.
  // Useful for spotting drift between stored status and current rules.
  currentDecision: {
    status: PrDecision["status"];
    reason: string | null;
    bypassReason: string | null;
    drifts: boolean;
  } | null;
};

const overviewSchema = z.object({
  projectId: z.string().min(1),
  prCheckId: z.string().min(1),
});

export async function getPrOverview(args: {
  projectId: string;
  prCheckId: string;
}): Promise<PrOverview> {
  const { projectId, prCheckId } = overviewSchema.parse(args);
  await requireProjectRole(projectId, "REVIEWER");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      qualityEnabled: true,
      qualityConfig: true,
      checkerEnabled: true,
      labelEvaluate: true,
    },
  });
  if (!project) throw new Error("Project not found");

  const config = parseQualityConfig(project.qualityConfig);

  const check = await prisma.prCheck.findUnique({
    where: { id: prCheckId },
    include: {
      repo: {
        select: {
          id: true,
          fullName: true,
          projectId: true,
          installationId: true,
          ghRepoId: true,
        },
      },
      quality: project.qualityEnabled,
    },
  });
  if (!check || check.repo.projectId !== projectId) {
    throw new Error("PR not found");
  }

  let quality: PrOverview["quality"] = null;
  if (project.qualityEnabled && check.quality) {
    const signals = JSON.parse(check.quality.signalsRaw) as SignalsRaw;
    const summary = computeScore(signals, config);
    const heuristics: PrOverviewHeuristic[] = ALL_HEURISTICS.map((h) => {
      const sig = signals[h.id] as HeuristicResult | undefined;
      return {
        id: h.id,
        label: h.label,
        group: h.group,
        weight: h.weight,
        enabled: isHeuristicEnabled(h, config),
        ran: sig !== undefined,
        failed: sig?.failed === true,
        reason: sig?.reason,
        value: sig?.value ?? null,
      };
    });

    let files = 0;
    let filesTruncated = false;
    let commits = 0;
    try {
      const fetched = JSON.parse(check.quality.fetchedRaw) as {
        files?: unknown[];
        filesTruncated?: boolean;
        commits?: number;
      };
      if (Array.isArray(fetched.files)) files = fetched.files.length;
      filesTruncated = !!fetched.filesTruncated;
      if (typeof fetched.commits === "number") commits = fetched.commits;
    } catch {
      // tolerate malformed fetchedRaw
    }

    quality = {
      score: summary.score,
      failedCount: summary.failedIds.length,
      totalRan: summary.failedIds.length + summary.passedIds.length,
      computedAt: check.quality.computedAt.toISOString(),
      heuristics,
      files,
      filesTruncated,
      commits,
    };
  }

  // Author stats across the project. Bounded query: only counts what's tracked.
  const authorChecks = await prisma.prCheck.findMany({
    where: { repo: { projectId }, authorGhLogin: check.authorGhLogin },
    select: { status: true, closedByApp: true },
  });
  const authorStats = {
    total: authorChecks.length,
    pending: 0,
    approved: 0,
    denied: 0,
    bypassed: 0,
    closedByApp: 0,
  };
  for (const c of authorChecks) {
    if (c.status === "PENDING") authorStats.pending += 1;
    else if (c.status === "APPROVED") authorStats.approved += 1;
    else if (c.status === "DENIED") authorStats.denied += 1;
    else if (c.status === "BYPASSED") authorStats.bypassed += 1;
    if (c.closedByApp) authorStats.closedByApp += 1;
  }

  // Recompute the decision (read-only). Catches drift between stored status
  // and the current rules. Flips after manual decisions, app approvals, etc.
  let currentDecision: PrOverview["currentDecision"] = null;
  if (check.repo.ghRepoId) {
    try {
      const decision = await decideForPR({
        ghRepoId: check.repo.ghRepoId,
        prAuthorGhLogin: check.authorGhLogin,
        prAuthorGhId: check.authorGhId,
      });
      const projected =
        decision.status === "BYPASSED" ? "APPROVED" : decision.status;
      currentDecision = {
        status: decision.status,
        reason: "reason" in decision ? (decision.reason ?? null) : null,
        bypassReason:
          "bypassReason" in decision ? (decision.bypassReason ?? null) : null,
        drifts: projected !== "IGNORED" && projected !== check.status,
      };
    } catch (e) {
      logger.warn(
        { err: e, prCheckId: check.id },
        "currentDecision recompute failed"
      );
    }
  }

  return {
    id: check.id,
    repoFullName: check.repo.fullName,
    repoId: check.repo.id,
    prNumber: check.prNumber,
    prNodeId: check.prNodeId,
    authorGhLogin: check.authorGhLogin,
    authorGhId: check.authorGhId,
    status: check.status as PrOverview["status"],
    closedByApp: check.closedByApp,
    headSha: check.headSha,
    checkRunId: check.checkRunId,
    createdAt: check.createdAt.toISOString(),
    updatedAt: check.updatedAt.toISOString(),
    ghUrl: `https://github.com/${check.repo.fullName}/pull/${check.prNumber}`,
    mode: check.repo.installationId == null ? "ci" : "app",
    installationId: check.repo.installationId,
    checkerEnabled: project.checkerEnabled,
    qualityEnabled: project.qualityEnabled,
    evaluateLabel: project.labelEvaluate,
    quality,
    authorStats,
    currentDecision,
  };
}

const rescanSchema = z.object({
  projectId: z.string().min(1),
  prCheckIds: z.array(z.string().min(1)).min(1).max(100),
});

export type RescanResult = {
  scored: number;
  skipped: number;
  failed: number;
};

/**
 * Re-run quality scoring for one or more PrChecks. Skips the public warning
 * comment regardless of score: admin-triggered rescans should never spam
 * the PR. Only works for App-mode repos (CI mode has no installation).
 */
export async function rescanPrQuality(args: {
  projectId: string;
  prCheckIds: string[];
}): Promise<RescanResult> {
  const parsed = rescanSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      id: true,
      qualityEnabled: true,
      qualityConfig: true,
      qualityCommentMin: true,
      prTemplateHoneypots: true,
      qualityTemplateMatchPct: true,
      checkerEnabled: true,
      trackWhenDisabled: true,
    },
  });
  if (!project) throw new Error("Project not found");
  if (!project.qualityEnabled) {
    throw new Error("Quality scoring is disabled for this project.");
  }

  const checks = await prisma.prCheck.findMany({
    where: {
      id: { in: parsed.prCheckIds },
      repo: { projectId: parsed.projectId },
    },
    select: {
      id: true,
      prNumber: true,
      repo: { select: { fullName: true, installationId: true } },
    },
  });

  let scored = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of checks) {
    if (!c.repo.installationId) {
      skipped += 1;
      continue;
    }
    try {
      const res = await runQualityForPrCheck({
        prCheckId: c.id,
        installationId: c.repo.installationId,
        repoFullName: c.repo.fullName,
        prNumber: c.prNumber,
        project,
        skipComment: true,
      });
      if (res) scored += 1;
      else skipped += 1;
    } catch (e) {
      logger.warn({ err: e, prCheckId: c.id }, "rescan: scoring failed");
      failed += 1;
    }
  }

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "pr.quality_rescanned",
    payload: {
      requested: parsed.prCheckIds.length,
      scored,
      skipped,
      failed,
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/prs`);
  return { scored, skipped, failed };
}

const reevaluateSchema = z.object({
  projectId: z.string().min(1),
  prCheckIds: z.array(z.string().min(1)).min(1).max(50),
});

export type ReevaluateResult = {
  triggered: number;
  skipped: number;
  failed: number;
};

/**
 * Trigger re-evaluation of one or more PRs by adding the project's
 * `labelEvaluate` label. The webhook handler picks up the `labeled` event
 * and runs the full decision pipeline (close/reopen/comment/labels +
 * Check Run + quality), then strips the trigger label.
 *
 * Async by design: applies side effects via the existing webhook path so
 * we don't fork the decision logic. CI-mode repos (no installation) are
 * skipped: there's no webhook to fire.
 */
export async function reEvaluatePrs(args: {
  projectId: string;
  prCheckIds: string[];
}): Promise<ReevaluateResult> {
  const parsed = reevaluateSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: { labelEvaluate: true },
  });
  if (!project) throw new Error("Project not found");

  const checks = await prisma.prCheck.findMany({
    where: {
      id: { in: parsed.prCheckIds },
      repo: { projectId: parsed.projectId },
    },
    select: {
      id: true,
      prNumber: true,
      repo: { select: { fullName: true, installationId: true } },
    },
  });

  let triggered = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of checks) {
    if (!c.repo.installationId) {
      skipped += 1;
      continue;
    }
    const ref = repoRef(c.repo.fullName, c.repo.installationId);
    try {
      // Ensure the trigger label exists before tagging. First-time use on a
      // repo that hasn't seen any webhook yet would otherwise 422.
      await ensureLabel(
        ref,
        project.labelEvaluate,
        "5319e7",
        "Add to trigger a re-evaluation by the contribution checker"
      );
      await addLabel(ref, c.prNumber, project.labelEvaluate);
      triggered += 1;
    } catch (e) {
      logger.warn({ err: e, prCheckId: c.id }, "re-evaluate: label add failed");
      failed += 1;
    }
  }

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "pr.reevaluate_triggered",
    payload: {
      requested: parsed.prCheckIds.length,
      triggered,
      skipped,
      failed,
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/prs`);
  return { triggered, skipped, failed };
}
