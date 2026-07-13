import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fetchPrContext, type FetchedPrContext } from "@/lib/quality/fetch";
import {
  ALL_HEURISTICS,
  isHeuristicEnabled,
  parseHoneypots,
  parseQualityConfig,
  thresholdFor,
} from "@/lib/quality/registry";
import { computeScore } from "@/lib/quality/score";
import type {
  HeuristicSetting,
  PrContext,
  ScoreSummary,
  SignalsRaw,
} from "@/lib/quality/types";
import { commentOnPr, repoRef } from "@/lib/github/pr-actions";

export type QualityRunResult = {
  signalsRaw: SignalsRaw;
  summary: ScoreSummary;
};

type ProjectForQuality = {
  id: string;
  qualityEnabled: boolean;
  qualityConfig: string;
  qualityCommentMin: number;
  prTemplateHoneypots: string;
  qualityTemplateMatchPct: number;
  trackWhenDisabled: boolean;
  checkerEnabled: boolean;
};

/**
 * Run all enabled heuristics against an already-fetched PR context.
 * Pure-ish: only writes to PrQuality (no GitHub fetches). Used by both
 * the App-mode `runQualityForPrCheck` (which fetches first) and CI-mode
 * paths where the workflow provides the context via the request body.
 */
export async function runQualityFromContext(args: {
  prCheckId: string;
  project: ProjectForQuality;
  fetched: FetchedPrContext;
}): Promise<QualityRunResult | null> {
  if (!args.project.qualityEnabled) return null;
  const config = parseQualityConfig(args.project.qualityConfig);
  const honeypots = parseHoneypots(args.project.prTemplateHoneypots);

  const ctx: PrContext = {
    project: {
      id: args.project.id,
      qualityConfig: config,
      prTemplateHoneypots: honeypots,
      templateMatchPct: args.project.qualityTemplateMatchPct,
    },
    pr: args.fetched.pr,
    prTemplate: args.fetched.prTemplate,
    files: args.fetched.files,
    filesTruncated: args.fetched.filesTruncated,
    commits: args.fetched.commits,
    account: args.fetched.account,
  };

  const signals: SignalsRaw = {};
  for (const h of ALL_HEURISTICS) {
    if (!isHeuristicEnabled(h, config)) continue;
    try {
      signals[h.id] = h.run(ctx, thresholdFor(h, config));
    } catch (e) {
      logger.warn({ err: e, heuristic: h.id }, "heuristic threw");
      signals[h.id] = { failed: false, reason: "heuristic-error" };
    }
  }

  const summary = computeScore(signals, config);
  await prisma.prQuality.upsert({
    where: { prCheckId: args.prCheckId },
    update: {
      signalsRaw: JSON.stringify(signals),
      fetchedRaw: JSON.stringify({
        files: ctx.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
        filesTruncated: ctx.filesTruncated,
        commits: ctx.commits.length,
      }),
      computedAt: new Date(),
    },
    create: {
      prCheckId: args.prCheckId,
      signalsRaw: JSON.stringify(signals),
      fetchedRaw: JSON.stringify({
        files: ctx.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
        filesTruncated: ctx.filesTruncated,
        commits: ctx.commits.length,
      }),
    },
  });

  if (summary.score !== null) {
    Sentry.metrics.distribution("pr.quality.score", summary.score, {
      attributes: { mode: "ci" },
    });
  }
  return { signalsRaw: signals, summary };
}

/**
 * Run all enabled heuristics on a PR and persist signals to PrQuality.
 * Returns the run summary (score + failed/passed ids), or null if quality
 * scoring should not run (feature off, fetch failed, etc.).
 *
 * When the score falls below `project.qualityCommentMin`, posts a public
 * PR comment with a brief breakdown: the only public-facing surface for
 * quality. Otherwise, scores are admin-only.
 */
export async function runQualityForPrCheck(args: {
  prCheckId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  project: ProjectForQuality;
  /** When true, skip the public warning comment (e.g., for backfill jobs). */
  skipComment?: boolean;
}): Promise<QualityRunResult | null> {
  if (!args.project.qualityEnabled) return null;

  const config = parseQualityConfig(args.project.qualityConfig);
  const honeypots = parseHoneypots(args.project.prTemplateHoneypots);

  // Build the set of enabled heuristic ids, used to short-circuit expensive
  // search-API calls for account heuristics that are off.
  const enabledIds = new Set<string>();
  for (const h of ALL_HEURISTICS) if (isHeuristicEnabled(h, config)) enabledIds.add(h.id);
  if (enabledIds.size === 0) return null;

  const [owner, repo] = args.repoFullName.split("/");
  if (!owner || !repo) return null;

  const fetched = await fetchPrContext({
    installationId: args.installationId,
    owner,
    repo,
    prNumber: args.prNumber,
    enabledHeuristicIds: enabledIds,
  });
  if (!fetched) return null;

  const ctx: PrContext = {
    project: {
      id: args.project.id,
      qualityConfig: config,
      prTemplateHoneypots: honeypots,
      templateMatchPct: args.project.qualityTemplateMatchPct,
    },
    pr: fetched.pr,
    prTemplate: fetched.prTemplate,
    files: fetched.files,
    filesTruncated: fetched.filesTruncated,
    commits: fetched.commits,
    account: fetched.account,
  };

  const signals: SignalsRaw = {};
  for (const h of ALL_HEURISTICS) {
    if (!isHeuristicEnabled(h, config)) continue;
    try {
      signals[h.id] = h.run(ctx, thresholdFor(h, config));
    } catch (e) {
      logger.warn({ err: e, heuristic: h.id }, "heuristic threw");
      signals[h.id] = { failed: false, reason: "heuristic-error" };
    }
  }

  const summary = computeScore(signals, config);

  await prisma.prQuality.upsert({
    where: { prCheckId: args.prCheckId },
    update: {
      signalsRaw: JSON.stringify(signals),
      fetchedRaw: JSON.stringify({
        files: ctx.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
        filesTruncated: ctx.filesTruncated,
        commits: ctx.commits.length,
        accountAt: new Date().toISOString(),
      }),
      computedAt: new Date(),
    },
    create: {
      prCheckId: args.prCheckId,
      signalsRaw: JSON.stringify(signals),
      fetchedRaw: JSON.stringify({
        files: ctx.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
        filesTruncated: ctx.filesTruncated,
        commits: ctx.commits.length,
        accountAt: new Date().toISOString(),
      }),
    },
  });

  // Public warning comment when score is concerning. Posted at most once per
  // PrCheck: the warnCommentedAt claim is taken atomically before posting so
  // synchronize re-runs (and concurrent deliveries) never post a duplicate.
  if (
    !args.skipComment &&
    summary.score !== null &&
    summary.score < args.project.qualityCommentMin
  ) {
    const claimed = await prisma.prQuality.updateMany({
      where: { prCheckId: args.prCheckId, warnCommentedAt: null },
      data: { warnCommentedAt: new Date() },
    });
    if (claimed.count === 1) {
      try {
        await postQualityWarningComment({
          installationId: args.installationId,
          repoFullName: args.repoFullName,
          prNumber: args.prNumber,
          summary,
          signals,
          config,
        });
      } catch (e) {
        logger.warn(
          { err: e, prCheckId: args.prCheckId },
          "quality comment failed"
        );
        // Release the claim so a later re-run can retry the comment.
        await prisma.prQuality
          .updateMany({
            where: { prCheckId: args.prCheckId },
            data: { warnCommentedAt: null },
          })
          .catch(() => {});
      }
    }
  }

  if (summary.score !== null) {
    Sentry.metrics.distribution("pr.quality.score", summary.score, {
      attributes: { mode: "app" },
    });
  }
  return { signalsRaw: signals, summary };
}

async function postQualityWarningComment(args: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  summary: ScoreSummary;
  signals: SignalsRaw;
  config: Record<string, HeuristicSetting>;
}): Promise<void> {
  const ref = repoRef(args.repoFullName, args.installationId);
  const failed = args.summary.failedIds
    .map((id) => {
      const h = ALL_HEURISTICS.find((x) => x.id === id);
      const sig = args.signals[id];
      return h ? `- **${h.label}**${sig?.reason ? `: ${sig.reason}` : ""}` : null;
    })
    .filter(Boolean);
  const body = [
    `**Contribution-checker quality warning**`,
    `Heuristic score: **${args.summary.score}/100** (low). This is a non-blocking warning surfaced by the project's quality settings.`,
    "",
    "Heuristics that flagged:",
    ...failed,
    "",
    "If this is a genuine contribution, please add detail to your PR description and tighten the diff scope before reviewers look at it.",
  ].join("\n");
  await commentOnPr(ref, args.prNumber, body);
}
