import { acts } from "./proxies";

/**
 * Scheduled App-mode reconcile safety net. A fresh run each fire (driven by a
 * Temporal Schedule), so history stays small; within the run it iterates
 * projects via bounded activities rather than an unbounded in-workflow loop.
 */
export async function reconcileSweep(): Promise<{ projects: number; reopened: number }> {
  const projectIds = await acts.listReconcileProjects();
  let reopened = 0;
  for (const projectId of projectIds) {
    const res = await acts.reconcileProject(projectId);
    reopened += res.reopened;
  }
  return { projects: projectIds.length, reopened };
}

/** Scheduled CLA unsigned-applicant sweep across CLA-enabled projects. */
export async function claSweep(): Promise<{ projects: number; notified: number }> {
  const projectIds = await acts.listClaSweepProjects();
  let notified = 0;
  for (const projectId of projectIds) {
    const res = await acts.claSweepProject(projectId);
    notified += res.notified;
  }
  return { projects: projectIds.length, notified };
}

/** Scheduled prune of stale processed-delivery idempotency rows. */
export async function pruneProcessedDeliveries(): Promise<{ deleted: number }> {
  const deleted = await acts.pruneProcessedDeliveries();
  return { deleted };
}
