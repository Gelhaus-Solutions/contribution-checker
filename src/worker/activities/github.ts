import {
  handleInstallationEvent,
  handleInstallationReposEvent,
  handleMergeGroupEvent,
  handlePullRequestEvent,
  handlePushEvent,
  reGatePr,
  type PrEventResult,
} from "@/lib/github/webhook";
import {
  reconcileStagingBatch,
  type StagingReconcileResult,
} from "@/lib/github/staging";
import { classifyGithubError } from "@/lib/github/errors";
import type { GithubEventEnvelope } from "@/lib/temporal/contracts";

/**
 * Activity wrappers around the existing GitHub webhook handlers. The heavy,
 * idempotent side-effect logic (decision pipeline, labels, close/comment, Check
 * Run, Quality) is unchanged; it now runs inside a Temporal activity so it is
 * durably retried instead of executing inline in the webhook request and being
 * lost on failure. The handlers were already written to be idempotent
 * (PrCheck upsert, label set, comment dedup), which is exactly what activity
 * retries require.
 *
 * Errors are classified at this boundary: permanent GitHub failures (revoked
 * installation, deleted repo/PR, malformed request) become non-retryable
 * ApplicationFailures instead of burning the full retry policy.
 */
/**
 * prGate's converge for a GitHub event: runs the per-PR handler and surfaces
 * whether the PR reached a terminal state (merge / human close) so the entity
 * workflow can complete.
 */
export async function convergePrEvent(
  env: GithubEventEnvelope
): Promise<PrEventResult> {
  try {
    return await handlePullRequestEvent(env.payload as never);
  } catch (e) {
    throw classifyGithubError(e);
  }
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
  try {
    await reGatePr({ ghRepoId: Number(args.repoId), prNumber: args.prNumber });
  } catch (e) {
    throw classifyGithubError(e);
  }
}

/**
 * stagingBatch's converge: re-derive the repo's aggregate staging PR from live
 * GitHub state. A full re-derivation, so a retry is always safe and never
 * double-posts.
 */
export async function convergeStagingBatch(args: {
  repoId: string;
}): Promise<StagingReconcileResult> {
  try {
    return await reconcileStagingBatch({ repoId: args.repoId });
  } catch (e) {
    throw classifyGithubError(e);
  }
}

export async function processMergeGroupEvent(payload: unknown): Promise<void> {
  try {
    await handleMergeGroupEvent(payload as never);
  } catch (e) {
    throw classifyGithubError(e);
  }
}

export async function processPushEvent(payload: unknown): Promise<void> {
  try {
    await handlePushEvent(payload as never);
  } catch (e) {
    throw classifyGithubError(e);
  }
}

export async function processInstallationEvent(
  kind: "installation" | "installation_repositories",
  payload: unknown
): Promise<void> {
  try {
    if (kind === "installation") {
      await handleInstallationEvent(payload as never);
    } else {
      await handleInstallationReposEvent(payload as never);
    }
  } catch (e) {
    throw classifyGithubError(e);
  }
}
