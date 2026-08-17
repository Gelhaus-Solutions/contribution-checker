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
  STAGING_SYNC_WINDOW_MS,
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
  let lastSyncMs: number | null = input.lastSyncMs ?? null;
  let syncDeferred = false;
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
    lastSyncMs,
    syncDeferred,
  }));

  setGateStatus("active");

  /** Epoch ms at which a sync is allowed again, or null when one may run now. */
  const syncNotBefore = (): number | null =>
    lastSyncMs == null ? null : lastSyncMs + STAGING_SYNC_WINDOW_MS;

  while (!shouldContinueAsNew(reconciles)) {
    // With a sync waiting on the batching window, wake when the window closes
    // rather than idling out, so the deferred sync actually happens instead of
    // waiting for whatever event happens to come next.
    const notBefore = syncNotBefore();
    const waitMs =
      syncDeferred && notBefore != null
        ? Math.max(0, notBefore - Date.now())
        : null;
    const hasWork = await condition(
      () => dirty,
      waitMs == null ? IDLE_TIMEOUT : waitMs,
    );
    if (!hasWork) {
      if (!syncDeferred) {
        setGateStatus("idle");
        return;
      }
      // The window closed: run the sync we held back.
      dirty = true;
    }

    // Debounce a burst into one pass. Requests that land during the wait are
    // absorbed by the flag we are about to clear, so nothing is lost.
    await sleep(STAGING_RECONCILE_DEBOUNCE);
    dirty = false;
    const now = Date.now();
    const allowSync = notBefore == null || now >= notBefore;
    const res = await acts.convergeStagingBatch({
      repoId: input.repoId,
      allowSync,
    });
    reconciles += 1;
    if (res.synced) lastSyncMs = Date.now();
    syncDeferred = res.syncDeferred;
  }

  if (dirty || syncDeferred) {
    setGateStatus("continued");
    await continueAsNew<typeof stagingBatch>({
      repoId: input.repoId,
      dirty,
      lastReason,
      lastSyncMs,
    });
  }

  setGateStatus("idle");
}
