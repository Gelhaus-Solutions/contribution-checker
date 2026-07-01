import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  reconcileProjectClosedPrs,
  projectIdsWithAppRepos,
} from "@/lib/github/reconcile";
import { sweepUnsignedApplicants } from "@/lib/cla/notify";
import { signalPrReGate, signalProjectSweepTick } from "@/lib/temporal/start";

const PROCESSED_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Work-list for the reconcile sweeps (projects with App-mode repos). Used by
 * the ensureProjectGates keepalive to bootstrap/nudge project entities. */
export async function listReconcileProjects(): Promise<string[]> {
  return projectIdsWithAppRepos();
}

/**
 * Per-project reconcile pass. Besides the reopen counts it reports whether the
 * project is still ACTIVE (has App-mode repos; a projectGate retires when not)
 * and whether CLA sweeps apply, so the entity can arm/clear its CLA timer
 * without a second round-trip.
 */
export async function reconcileProject(
  projectId: string
): Promise<{
  reopened: number;
  evaluated: number;
  active: boolean;
  claEnabled: boolean;
}> {
  const base = await reconcileProjectClosedPrs(projectId);
  const [appRepos, project] = await Promise.all([
    prisma.repo.count({
      where: { projectId, active: true, installationId: { not: null } },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { claEnabled: true, claRequired: true },
    }),
  ]);
  return {
    ...base,
    active: appRepos > 0,
    claEnabled: !!(project?.claEnabled && project?.claRequired),
  };
}

/**
 * Paged PR-target query for the projectGate re-gate fan-out. Replaces the
 * Prisma query that used to run inline in the reGate*Prs server helpers (the
 * workflow can't touch Prisma). Cursor-paged so a project with thousands of
 * tracked PRs is fanned out in bounded batches.
 */
export async function listReGatePrTargets(args: {
  projectId: string;
  author: { ghId: number | null; ghLogin: string | null } | null;
  cursor: string | null;
  limit: number;
}): Promise<{
  targets: { ghRepoId: number; prNumber: number }[];
  nextCursor: string | null;
}> {
  const authorOr: Array<{ authorGhId?: number; authorGhLogin?: string }> = [];
  if (args.author?.ghId != null) authorOr.push({ authorGhId: args.author.ghId });
  if (args.author?.ghLogin) authorOr.push({ authorGhLogin: args.author.ghLogin });
  // An author filter that matches nothing must return nothing (not everything).
  if (args.author && authorOr.length === 0) {
    return { targets: [], nextCursor: null };
  }
  const rows = await prisma.prCheck.findMany({
    where: {
      ...(authorOr.length > 0 ? { OR: authorOr } : {}),
      repo: {
        projectId: args.projectId,
        active: true,
        installationId: { not: null },
      },
    },
    select: { id: true, prNumber: true, repo: { select: { ghRepoId: true } } },
    orderBy: { id: "asc" },
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    take: args.limit,
  });
  const targets = rows
    .filter((r) => r.repo.ghRepoId != null)
    .map((r) => ({ ghRepoId: r.repo.ghRepoId as number, prNumber: r.prNumber }));
  const nextCursor = rows.length === args.limit ? rows[rows.length - 1].id : null;
  return { targets, nextCursor };
}

/**
 * Batched reGate sender: the signalWithStart loop, inside ONE activity so the
 * fan-out retries as a unit and the projectGate's history stays O(pages)
 * instead of O(PRs). The shared nonce lets each prGate coalesce duplicates.
 */
export async function signalReGateBatch(args: {
  targets: { ghRepoId: number; prNumber: number }[];
  reason: string;
  nonce: string;
}): Promise<{ signaled: number }> {
  let signaled = 0;
  for (const t of args.targets) {
    await signalPrReGate(String(t.ghRepoId), t.prNumber, {
      reason: args.reason,
      nonce: args.nonce,
    });
    signaled += 1;
  }
  return { signaled };
}

/**
 * Keepalive fan-out for the ensureProjectGates schedule: signalWithStart a
 * sweepTick to every active project's entity, bootstrapping entities for new
 * projects and resurrecting any that idle-retired.
 */
export async function signalProjectGatesBatch(
  projectIds: string[]
): Promise<{ signaled: number }> {
  let signaled = 0;
  for (const projectId of projectIds) {
    await signalProjectSweepTick(projectId);
    signaled += 1;
  }
  return { signaled };
}

/** Work-list for the scheduled CLA sweep: every project that has CLA enabled +
 * required (the only ones where unsigned applicants matter). */
export async function listClaSweepProjects(): Promise<string[]> {
  const rows = await prisma.project.findMany({
    where: { claEnabled: true, claRequired: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function claSweepProject(
  projectId: string
): Promise<{ notified: number; skipped: number; total: number }> {
  // System-initiated sweep (no human actor).
  return sweepUnsignedApplicants({ projectId, actorId: null });
}

/** Replaces the inline `pruneStaleDeliveries` that used to ride on the webhook
 * route's 60-minute boundary. Now a tiny scheduled workflow. */
export async function pruneProcessedDeliveries(): Promise<number> {
  const res = await prisma.processedWebhookDelivery.deleteMany({
    where: {
      createdAt: { lt: new Date(Date.now() - PROCESSED_DELIVERY_RETENTION_MS) },
    },
  });
  logger.info({ deleted: res.count }, "pruned processed webhook deliveries");
  return res.count;
}
