import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { runQualityForPrCheck } from "@/lib/quality/run";

const PROJECT_QUALITY_SELECT = {
  id: true,
  qualityEnabled: true,
  qualityConfig: true,
  qualityCommentMin: true,
  prTemplateHoneypots: true,
  qualityTemplateMatchPct: true,
  checkerEnabled: true,
  trackWhenDisabled: true,
} as const;

export type BackfillTarget = {
  prCheckId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  projectId: string;
};

/** Resolve the set of PrChecks to (re)score, mirroring the legacy backfill
 * query (most-recently-updated first, capped). PrChecks on CI-mode repos with
 * no installationId are skipped (we can't fetch their diffs). */
export async function loadBackfillTargets(
  projectId: string,
  limit: number
): Promise<BackfillTarget[]> {
  const checks = await prisma.prCheck.findMany({
    where: { repo: { projectId } },
    select: {
      id: true,
      prNumber: true,
      repo: { select: { fullName: true, installationId: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, Math.min(limit, 200)),
  });
  return checks
    .filter((c) => c.repo.installationId != null)
    .map((c) => ({
      prCheckId: c.id,
      installationId: c.repo.installationId as number,
      repoFullName: c.repo.fullName,
      prNumber: c.prNumber,
      projectId,
    }));
}

/** Score one PrCheck (no public warning comment — backfill is silent). Loads
 * the project config here so the workflow input stays small. */
export async function scorePrCheckForBackfill(
  target: BackfillTarget
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: target.projectId },
    select: PROJECT_QUALITY_SELECT,
  });
  if (!project || !project.qualityEnabled) return false;
  const res = await runQualityForPrCheck({
    prCheckId: target.prCheckId,
    installationId: target.installationId,
    repoFullName: target.repoFullName,
    prNumber: target.prNumber,
    project,
    skipComment: true,
  });
  return res != null;
}

export async function recordBackfillAudit(args: {
  projectId: string;
  actorId: string | null;
  phase: "started" | "completed";
  count: number;
  scored?: number;
}): Promise<void> {
  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind:
      args.phase === "started"
        ? "quality.backfill_started"
        : "quality.backfill_completed",
    payload:
      args.phase === "started"
        ? { count: args.count }
        : { scored: args.scored ?? 0, total: args.count },
  });
  logger.info({ ...args }, "quality backfill audit");
}
