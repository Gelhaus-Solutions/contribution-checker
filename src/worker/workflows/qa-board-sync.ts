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
  QA_BOARD_POLL_INTERVAL_MS,
  QA_BOARD_SYNC_DEBOUNCE,
  QRY,
  SIG,
} from "../../lib/temporal/contracts";
import { SA, type GateStatusValue } from "../../lib/temporal/search-attributes";
import type {
  QaBoardSyncInput,
  QaBoardSyncPayload,
  QaBoardSyncState,
  QaTaskToggleInput,
  QaTaskToggleResult,
} from "../../lib/temporal/contracts";

const qaBoardSyncSignal = defineSignal<[QaBoardSyncPayload]>(SIG.qaBoardSync);
const qaBoardSyncState = defineQuery<QaBoardSyncState>(QRY.qaBoardSyncState);

/** Hard backstop before Continue-As-New. This workflow polls, so it rolls more
 * often than the staging entity does. */
const SYNCS_BEFORE_CONTINUE = 500;

function shouldContinueAsNew(syncs: number): boolean {
  return workflowInfo().continueAsNewSuggested || syncs >= SYNCS_BEFORE_CONTINUE;
}

function setGateStatus(status: GateStatusValue): void {
  upsertSearchAttributes([{ key: SA.GateStatus, value: status }]);
}

/**
 * Per-repo mirror of the QA board into Notion and Trello, in both directions.
 *
 * Structured as a **poll that signals can hurry along**, rather than as a
 * webhook handler with a poll bolted on as a backstop. That ordering is
 * deliberate and it is the same reasoning the staging manifest is built on: the
 * pull is a full reconciliation of the provider's state, so a webhook that is
 * late, duplicated, unverifiable or never sent at all costs latency and never
 * correctness. It also lets one mechanism serve both providers, where Notion
 * gives an integration no per-database webhook and a Trello hook can be deleted
 * out from under us at any time.
 *
 * The activity reports whether a pull actually changed anything. When it did,
 * the staging batch is signalled so the release PR body and the QA check catch
 * up: a verdict recorded in Notion has to be able to turn the check green
 * without anyone opening the dashboard, or the integration is decorative.
 */
export async function qaBoardSync(
  input: QaBoardSyncInput,
): Promise<void> {
  let dirty = input.dirty ?? true;
  let lastReason: string | null = input.lastReason ?? null;
  let syncs = 0;
  let applied = 0;

  setHandler(qaBoardSyncSignal, (payload) => {
    dirty = true;
    lastReason = payload.reason;
  });
  setHandler(qaBoardSyncState, (): QaBoardSyncState => ({
    repoId: input.repoId,
    dirty,
    lastReason,
    syncs,
    applied,
  }));

  setGateStatus("active");

  while (!shouldContinueAsNew(syncs)) {
    // Waking on the poll interval rather than idling out is what keeps the pull
    // half alive: nothing local happens when somebody moves a card in Trello,
    // so there is no signal to wait for.
    const hasWork = await condition(() => dirty, QA_BOARD_POLL_INTERVAL_MS);
    if (hasWork) {
      // Absorb a burst of verdicts into one pass over the provider API.
      await sleep(QA_BOARD_SYNC_DEBOUNCE);
    }
    dirty = false;

    const res = await acts.syncQaBoard({ repoId: input.repoId });
    syncs += 1;
    applied += res.applied;

    // Nothing to mirror and nothing pending: stop rather than poll an idle repo
    // forever. A later signal simply starts a fresh run.
    if (res.idle && !dirty) {
      setGateStatus("idle");
      return;
    }

    if (res.applied > 0) {
      // A provider-side verdict has to reach the release PR and the check, and
      // the staging entity owns both.
      await acts.signalStagingReconcile({
        repoId: input.repoId,
        reason: "qa_board_pull",
      });
    }
  }

  setGateStatus("continued");
  await continueAsNew<typeof qaBoardSync>({
    repoId: input.repoId,
    dirty,
    lastReason,
  });
}

/**
 * One checkbox tick, written to the PR body.
 *
 * A workflow for a single activity call looks like overhead, and it buys the
 * house rule: GitHub side effects outside the webhook path go through Temporal,
 * so a write that fails mid-flight is retried by the same machinery as every
 * other one rather than being lost with the request that started it.
 *
 * The caller awaits the result, because the reviewer clicked a box and deserves
 * to be told when the description moved under them instead of watching the tick
 * silently revert on the next reconcile.
 */
export async function qaTaskToggle(
  input: QaTaskToggleInput,
): Promise<QaTaskToggleResult> {
  return acts.toggleQaTask(input);
}
