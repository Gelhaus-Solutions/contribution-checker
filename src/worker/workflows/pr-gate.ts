import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import { QRY, SIG } from "../../lib/temporal/contracts";
import type {
  GithubEventEnvelope,
  PrChildCompletedPayload,
  PrGateInput,
  PrGateState,
  ReGatePayload,
} from "../../lib/temporal/contracts";

const githubEvent = defineSignal<[GithubEventEnvelope]>(SIG.githubEvent);
const reGate = defineSignal<[ReGatePayload]>(SIG.reGate);
const prGateState = defineQuery<PrGateState>(QRY.prGateState);

/**
 * Tell the contributor parent this PR child has completed so it can drop us from
 * its live-children set. Only when started as a child (workflowInfo().parent is
 * set); a top-level prGate (a re-gate orphan) has no parent. Best-effort: if the
 * parent already completed the signal fails harmlessly.
 */
async function notifyParentCompleted(): Promise<void> {
  const parent = workflowInfo().parent;
  if (!parent) return;
  try {
    await getExternalWorkflowHandle(parent.workflowId).signal(
      SIG.prChildCompleted,
      { childWorkflowId: workflowInfo().workflowId } satisfies PrChildCompletedPayload,
    );
  } catch {
    // Parent already gone; nothing to clean up.
  }
}

/** Continue-As-New once a busy PR has processed this many events so a PR that
 * sees many `synchronize`/re-gate events over its lifetime never approaches the
 * history-event ceiling. */
const EVENTS_BEFORE_CONTINUE = 500;

/** How long to wait for the next event once the queue is drained before the
 * workflow COMPLETES. A later event simply signalWithStarts a fresh run. Keeps a
 * window open to coalesce rapid bursts without leaving a workflow Running forever
 * per open PR. */
const IDLE_TIMEOUT = "1 minute";

/**
 * Per-PR entity workflow (one per repo+PR), the leaf of the
 * project → contributor → pr tree. It lives while the PR is open.
 *
 * Two signals drive it: `githubEvent` (a raw webhook envelope, including
 * `closed`/merged) and `reGate` (a parent gate says "re-evaluate"). Both lead to
 * a single converge: GitHub events run the existing per-PR handler (which
 * carries authoritative state); a `reGate` re-fetches current state and
 * converges. Converges are idempotent, so duplicate signals are no-ops and a
 * re-gate nonce already applied is skipped (coalescing the fast and completeness
 * fan-out paths).
 *
 * It COMPLETES on a terminal close (merge or human close, surfaced by the event
 * handler) or after IDLE_TIMEOUT of silence. A `closedByApp` pending/denied
 * close is NOT terminal: the PR must stay reopenable, so the entity keeps living.
 * A busy PR Continue-As-News at EVENTS_BEFORE_CONTINUE to bound history.
 */
export async function prGate(input: PrGateInput): Promise<void> {
  const queue: GithubEventEnvelope[] = [
    ...(input.first ? [input.first] : []),
    ...(input.pending ?? []),
  ];
  let pendingReGate: ReGatePayload | null = input.pendingReGate ?? null;
  let lastNonce: string | null = input.lastNonce ?? null;
  let terminal = false;
  let processed = 0;

  setHandler(githubEvent, (env) => {
    queue.push(env);
  });
  setHandler(reGate, (payload) => {
    // Keep only the latest pending re-gate; the converge always reads current
    // state, so an older un-applied request is subsumed by a newer one.
    pendingReGate = payload;
  });
  // Ops/debugging read of the gate's durable state. Pure closure read: never
  // mutates, never emits commands, so it is replay-safe on old histories.
  setHandler(prGateState, (): PrGateState => ({
    repoId: input.repoId,
    prNumber: input.prNumber,
    pendingEvents: queue.length,
    pendingReGate,
    lastNonce,
    terminal,
    processed,
  }));

  while (processed < EVENTS_BEFORE_CONTINUE) {
    const hasWork = await condition(
      () => queue.length > 0 || pendingReGate !== null,
      IDLE_TIMEOUT,
    );
    if (!hasWork) {
      // Idle → complete; a later signal starts a fresh run.
      await notifyParentCompleted();
      return;
    }

    // Drain GitHub events first: they carry authoritative state and can be
    // terminal. Keep the event in the queue until the activity succeeds so a
    // Continue-As-New (or crash) never drops it.
    if (queue.length > 0) {
      const res = await acts.convergePrEvent(queue[0]);
      queue.shift();
      processed += 1;
      if (res.terminal) {
        terminal = true;
        break;
      }
      continue;
    }

    // A re-gate request (no payload): re-evaluate by fetching current state.
    const req = pendingReGate as ReGatePayload;
    pendingReGate = null;
    // Coalesce: a repeat re-gate with a nonce we already applied is a no-op.
    if (req.nonce && req.nonce === lastNonce) continue;
    await acts.convergePrReGate({
      repoId: input.repoId,
      prNumber: input.prNumber,
      reason: req.reason,
    });
    if (req.nonce) lastNonce = req.nonce;
    processed += 1;
  }

  if (terminal) {
    // PR merged/human-closed → entity completes.
    await notifyParentCompleted();
    return;
  }

  // Hit the history cap with work still pending: roll it into a fresh run (the
  // workflow id and parent link are preserved across Continue-As-New).
  if (queue.length > 0 || pendingReGate !== null) {
    await continueAsNew<typeof prGate>({
      repoId: input.repoId,
      prNumber: input.prNumber,
      pending: queue,
      pendingReGate,
      lastNonce,
    });
  }
}
