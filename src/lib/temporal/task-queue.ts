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
  mergeGroup: (repoId: string, headSha: string) =>
    `mergegroup:${repoId}:${headSha}`,
  push: (repoId: string, ref: string, after: string) =>
    `push:${repoId}:${ref}:${after}`,
  installation: (installationId: number, deliveryId: string) =>
    `installation:${installationId}:${deliveryId}`,
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

/** Schedule ids for the recurring sweeps. */
export const scheduleIds = {
  reconcileSweep: "schedule:reconcile-sweep",
  claSweep: "schedule:cla-sweep",
  pruneProcessedDeliveries: "schedule:prune-processed-deliveries",
} as const;
