import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  upsertSearchAttributes,
  workflowInfo,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import {
  QRY,
  SIG,
  STAGING_RECONCILE_DEBOUNCE,
} from "../../lib/temporal/contracts";
import { SA, type GateStatusValue } from "../../lib/temporal/search-attributes";
import type {
  StagingBatchInput,
  StagingBatchState,
  StagingReconcilePayload,
} from "../../lib/temporal/contracts";

const stagingReconcile = defineSignal<[StagingReconcilePayload]>(
  SIG.stagingReconcile,
);
const stagingBatchState = defineQuery<StagingBatchState>(QRY.stagingBatchState);

/** Hard backstop before Continue-As-New; the server's suggestion is the primary
 * trigger. Unlike prGate this workflow has no shipped histories, so neither
 * needs a patch guard. */
const RECONCILES_BEFORE_CONTINUE = 500;

function shouldContinueAsNew(reconciles: number): boolean {
  return (
    workflowInfo().continueAsNewSuggested ||
    reconciles >= RECONCILES_BEFORE_CONTINUE
  );
}

function setGateStatus(status: GateStatusValue): void {
  upsertSearchAttributes([{ key: SA.GateStatus, value: status }]);
}

/** How long to wait for the next request once the batch is settled before the
 * workflow COMPLETES. A later signal simply signalWithStarts a fresh run. */
const IDLE_TIMEOUT = "2 minutes";

/**
 * Per-repo staging batch entity (one per repo). It owns the aggregate
 * `staging -> default` PR: creating it while staging is ahead of the default
 * branch, and keeping its description an accurate manifest of the batch.
 *
 * One signal drives it: `stagingReconcile`, sent whenever anything that could
 * change the batch happens (a PR retargeted onto staging, a PR on staging
 * merged or closed, a PR title edited, a push to staging, the setting switched
 * on). The signal carries no state, because reconciling is a full
 * re-derivation from live GitHub: N requests collapse into one pass, and a
 * request that arrives mid-reconcile simply schedules exactly one more.
 *
 * Existing as an entity rather than running inline is what makes concurrency
 * safe: two PRs opening at the same instant cannot race into two aggregate PRs
 * or clobber each other's manifest, because every reconcile for a repo is
 * serialized through this one workflow.
 */
export async function stagingBatch(input: StagingBatchInput): Promise<void> {
  let dirty = input.dirty ?? false;
  let lastReason: string | null = input.lastReason ?? null;
  let reconciles = 0;

  setHandler(stagingReconcile, (payload) => {
    dirty = true;
    lastReason = payload.reason;
  });
  setHandler(stagingBatchState, (): StagingBatchState => ({
    repoId: input.repoId,
    dirty,
    lastReason,
    reconciles,
  }));

  setGateStatus("active");

  while (!shouldContinueAsNew(reconciles)) {
    const hasWork = await condition(() => dirty, IDLE_TIMEOUT);
    if (!hasWork) {
      setGateStatus("idle");
      return;
    }

    // Debounce a burst into one pass. Requests that land during the wait are
    // absorbed by the flag we are about to clear, so nothing is lost.
    await sleep(STAGING_RECONCILE_DEBOUNCE);
    dirty = false;
    await acts.convergeStagingBatch({ repoId: input.repoId });
    reconciles += 1;
  }

  if (dirty) {
    setGateStatus("continued");
    await continueAsNew<typeof stagingBatch>({
      repoId: input.repoId,
      dirty,
      lastReason,
    });
  }

  setGateStatus("idle");
}
