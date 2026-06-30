import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  reconcileProjectClosedPrs,
  projectIdsWithAppRepos,
} from "@/lib/github/reconcile";
import { sweepUnsignedApplicants } from "@/lib/cla/notify";

const PROCESSED_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Work-list for the scheduled reconcile sweep. */
export async function listReconcileProjects(): Promise<string[]> {
  return projectIdsWithAppRepos();
}

export async function reconcileProject(
  projectId: string
): Promise<{ reopened: number; evaluated: number }> {
  return reconcileProjectClosedPrs(projectId);
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
