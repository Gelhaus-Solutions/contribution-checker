import { acts } from "./proxies";

/**
 * RETIRED (kept through one deploy cycle): the global reconcile sweep is now
 * per-project timers on the projectGate entity. This export stays so an
 * in-flight run scheduled by the old cron can still complete; ensureSchedules
 * deletes the old schedule. Remove once no reconcileSweep executions are open.
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

/** RETIRED like reconcileSweep: the CLA sweep is now a per-project timer on
 * the projectGate entity. Remove once no claSweep executions are open. */
export async function claSweep(): Promise<{ projects: number; notified: number }> {
  const projectIds = await acts.listClaSweepProjects();
  let notified = 0;
  for (const projectId of projectIds) {
    const res = await acts.claSweepProject(projectId);
    notified += res.notified;
  }
  return { projects: projectIds.length, notified };
}

/**
 * Keepalive for the project entities (scheduled): enumerate active projects
 * and signalWithStart each projectGate with a sweepTick. Bootstraps entities
 * for newly-active projects, resurrects retired ones, and is a no-op nudge for
 * running ones. The per-project sweep timers live on the entities themselves.
 */
export async function ensureProjectGates(): Promise<{ projects: number }> {
  const projectIds = await acts.listReconcileProjects();
  if (projectIds.length > 0) {
    await acts.signalProjectGatesBatch(projectIds);
  }
  return { projects: projectIds.length };
}

/** Scheduled prune of stale processed-delivery idempotency rows. */
export async function pruneProcessedDeliveries(): Promise<{ deleted: number }> {
  const deleted = await acts.pruneProcessedDeliveries();
  return { deleted };
}

/**
 * Every minute: GPlatform Terms' outbox, flushed once (GPLATTERMS-43). A
 * failed flush is not retried here; the next minute takes up where it stopped.
 */
export async function flushTermsOutbox(): Promise<{
  delivered: number;
  retrying: number;
  parked: number;
} | null> {
  return acts.flushTermsOutbox();
}

/**
 * Every minute: the chains in GPlatform Legal of the projects moved there,
 * read past the entry last followed (D126); what Legal's staff wrote there has
 * the project's pull requests checked again. A failed project is read again
 * the next minute.
 */
export async function followClaLegal(): Promise<{
  projects: number;
  entries: number;
  regated: number;
} | null> {
  return acts.followClaLegal();
}

/**
 * Daily: tells GLockdown which decoys this app checks, as hashes only (L120),
 * so a decoy in GLockdown's inventory that is no longer checked here shows up
 * there. The activity never throws; a failed report is audited and tomorrow's
 * run takes it up.
 */
export async function reportGlockdownDecoys(): Promise<{ ok: boolean; code: string | null }> {
  return acts.reportGlockdownDecoys();
}

/** Scheduled deletion of records past their retention period. */
export async function pruneRetainedRecords(): Promise<{
  rateLimitBuckets: number;
  auditEvents: number;
  aiResults: number;
}> {
  return acts.pruneRetainedRecords();
}
