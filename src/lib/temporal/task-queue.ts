import { env } from "@/lib/env";

/**
 * The single task queue every workflow and the worker share. One app, one
 * namespace, one queue (see the migration plan: Nexus and multi-queue splits
 * are intentionally out of scope). Overridable via TEMPORAL_TASK_QUEUE so a
 * staging deploy can isolate itself from prod on a shared cluster.
 */
export const TASK_QUEUE = env.TEMPORAL_TASK_QUEUE;

/**
 * Stable workflow id builders. Ids are deterministic so that signalWithStart
 * deduplicates: a second PR event for the same PR signals the running entity
 * workflow instead of starting a duplicate.
 */
export const workflowIds = {
  pullRequest: (repoId: string, prNumber: number) =>
    `pr:${repoId}:${prNumber}`,
  contributor: (projectId: string, authorGhId: number) =>
    `contrib:${projectId}:${authorGhId}`,
  project: (projectId: string) => `project:${projectId}`,
  mergeGroup: (repoId: string, headSha: string) =>
    `mergegroup:${repoId}:${headSha}`,
  push: (repoId: string, ref: string, after: string) =>
    `push:${repoId}:${ref}:${after}`,
  installation: (installationId: number, deliveryId: string) =>
    `installation:${installationId}:${deliveryId}`,
  /** Per-repo staging batch entity. Keyed by the local `Repo.id` (not
   * ghRepoId): the reconcile needs the Repo row anyway, and a CI-mode repo
   * with no ghRepoId must still get a stable id. */
  qaBoardSync: (repoId: string) => `qa-board:${repoId}`,
  qaTaskToggle: (itemId: string, nonce: string) => `qa-task:${itemId}:${nonce}`,
  aiRun: (taskId: string, subjectId: string) => `ai:${taskId}:${subjectId}`,
  stagingBatch: (repoId: string) => `staging:${repoId}`,
  ciCheckPr: (projectSlug: string, prNumber: number, headSha: string) =>
    `ci-check:${projectSlug}:${prNumber}:${headSha}`,
  ciReconcile: (projectSlug: string, repoFullName: string) =>
    `ci-reconcile:${projectSlug}:${repoFullName}`,
  outboundWebhook: (deliveryKey: string) => `whdeliver:${deliveryKey}`,
  qualityBackfill: (projectId: string, nonce: string) =>
    `quality-backfill:${projectId}:${nonce}`,
  qualityScorePr: (prCheckId: string) => `quality-score:${prCheckId}`,
  mutatePr: (prCheckId: string, kind: string, nonce: string) =>
    `mutate-pr:${prCheckId}:${kind}:${nonce}`,
} as const;

/** Schedule ids for the recurring sweeps. `reconcileSweep`/`claSweep` are
 * retired (their work moved into per-project projectGate timers) but the ids
 * are kept so ensureSchedules can actively delete the old schedules. */
export const scheduleIds = {
  reconcileSweep: "schedule:reconcile-sweep",
  claSweep: "schedule:cla-sweep",
  ensureProjectGates: "schedule:ensure-project-gates",
  pruneProcessedDeliveries: "schedule:prune-processed-deliveries",
} as const;
