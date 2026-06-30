import {
  handleInstallationEvent,
  handleInstallationReposEvent,
  handleMergeGroupEvent,
  handlePullRequestEvent,
  handlePushEvent,
  reGatePr,
  type PrEventResult,
} from "@/lib/github/webhook";
import type { GithubEventEnvelope } from "@/lib/temporal/contracts";

/**
 * Activity wrappers around the existing GitHub webhook handlers. The heavy,
 * idempotent side-effect logic (decision pipeline, labels, close/comment, Check
 * Run, Quality) is unchanged; it now runs inside a Temporal activity so it is
 * durably retried instead of executing inline in the webhook request and being
 * lost on failure. The handlers were already written to be idempotent
 * (PrCheck upsert, label set, comment dedup), which is exactly what activity
 * retries require.
 */
/**
 * prGate's converge for a GitHub event: runs the per-PR handler and surfaces
 * whether the PR reached a terminal state (merge / human close) so the entity
 * workflow can complete.
 */
export async function convergePrEvent(
  env: GithubEventEnvelope
): Promise<PrEventResult> {
  return handlePullRequestEvent(env.payload as never);
}

/**
 * prGate's converge for a `reGate` request (no webhook payload): re-fetch the
 * PR's current state and converge with re-evaluation semantics.
 */
export async function convergePrReGate(args: {
  repoId: string;
  prNumber: number;
  reason?: string;
}): Promise<void> {
  await reGatePr({ ghRepoId: Number(args.repoId), prNumber: args.prNumber });
}

export async function processMergeGroupEvent(payload: unknown): Promise<void> {
  await handleMergeGroupEvent(payload as never);
}

export async function processPushEvent(payload: unknown): Promise<void> {
  await handlePushEvent(payload as never);
}

export async function processInstallationEvent(
  kind: "installation" | "installation_repositories",
  payload: unknown
): Promise<void> {
  if (kind === "installation") {
    await handleInstallationEvent(payload as never);
  } else {
    await handleInstallationReposEvent(payload as never);
  }
}
