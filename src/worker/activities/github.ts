import { inBulkLane } from "@/lib/github/budget";
import {
  handleInstallationEvent,
  handleInstallationReposEvent,
  handleMergeGroupEvent,
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  handlePushEvent,
  reGatePr,
  type PrEventResult,
} from "@/lib/github/webhook";
import {
  reconcileStagingBatch,
  type StagingReconcileResult,
} from "@/lib/github/staging";
import { ApplicationFailure } from "@temporalio/common";
import { classifyGithubError } from "@/lib/github/errors";
import {
  isGmintOutage,
  watchGmint,
  type GmintRefusal,
} from "@/lib/github/gmint-tokens";
import {
  FAILURE,
  type GithubEventEnvelope,
} from "@/lib/temporal/contracts";

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
    return await untilGmintAnswered(async () => {
      // A review arrives on the same entity as the PR's own events, so it is
      // handled here rather than through a workflow of its own. It is never
      // terminal: approving a PR does not close it, and reporting otherwise
      // would complete the entity while the PR is still open.
      if (env.eventName === "pull_request_review") {
        await handlePullRequestReviewEvent(env.payload as never);
        return { terminal: false };
      }
      return await handlePullRequestEvent(env.payload as never);
    });
  } catch (e) {
    throw classifyGithubError(e);
  }
}

/**
 * Runs one converge and refuses to report it done when GMint stopped answering
 * during it. Each GitHub write catches and logs its own failure, so without
 * this a PR gated while GMint was down completed with no check, no label and no
 * comment, and nothing ever asked again. Non-retryable on purpose: eight quick
 * attempts cannot outlast a broker that needs a person to unseal it, so prGate
 * waits on a timer instead and converges again, keeping the event queued.
 */
async function untilGmintAnswered<T>(work: () => Promise<T>): Promise<T> {
  let outage: GmintRefusal;
  try {
    const watched = await watchGmint(work);
    if (!watched.outage) return watched.value;
    outage = watched.outage;
  } catch (e) {
    // A read the converge cannot go on without (reGatePr's PR fetch) throws
    // the refusal itself rather than swallowing it.
    if (!isGmintOutage(e)) throw e;
    outage = e;
  }
  throw ApplicationFailure.nonRetryable(
    `GMint is not answering (${outage.code}): the GitHub writes of this converge did not happen`,
    FAILURE.gmintUnavailable
  );
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
    // Re-gates arrive in project-wide fan-outs, so they spend the bulk share.
    await untilGmintAnswered(() =>
      inBulkLane(() =>
        reGatePr({ ghRepoId: Number(args.repoId), prNumber: args.prNumber })
      )
    );
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
    return await inBulkLane(() =>
      reconcileStagingBatch({ repoId: args.repoId })
    );
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
