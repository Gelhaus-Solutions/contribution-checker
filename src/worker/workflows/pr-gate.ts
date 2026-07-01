import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  patched,
  setHandler,
  upsertSearchAttributes,
  workflowInfo,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import { PATCHES, QRY, SIG } from "../../lib/temporal/contracts";
import { SA, type GateStatusValue } from "../../lib/temporal/search-attributes";
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

/** Hard backstop cap on events processed before Continue-As-New. The PRIMARY
 * trigger is the server's continueAsNewSuggested heuristic (history size and
 * event count); this cap only bounds the worst case if that signal is
 * unavailable, and doubles as the pre-patch threshold for old histories. */
const EVENTS_BEFORE_CONTINUE = 500;

/** Roll to a fresh run? Server suggestion first (patch-guarded: pre-patch
 * histories keep the fixed-threshold behavior verbatim), hard cap always. */
function shouldContinueAsNew(processed: number): boolean {
  if (patched(PATCHES.prGateCanSuggested)) {
    return (
      workflowInfo().continueAsNewSuggested ||
      processed >= EVENTS_BEFORE_CONTINUE
    );
  }
  return processed >= EVENTS_BEFORE_CONTINUE;
}

/** Update the GateStatus search attribute. upsert emits a command, so every
 * call is behind the search-attrs patch: a history recorded before the patch
 * replays without the command and stays deterministic. */
function setGateStatus(status: GateStatusValue): void {
  if (!patched(PATCHES.prGateSearchAttrs)) return;
  upsertSearchAttributes([{ key: SA.GateStatus, value: status }]);
}

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

  // Identity attributes so the execution is findable in the Temporal UI by
  // repo/status even when started as a child (a client start passes typed
  // attributes; startChild from the parent does not). repoId is a numeric
  // string; the attribute is INT (see search-attributes.ts).
  if (patched(PATCHES.prGateSearchAttrs)) {
    const repoIdNum = Number(input.repoId);
    upsertSearchAttributes([
      ...(Number.isFinite(repoIdNum)
        ? [{ key: SA.RepoId, value: repoIdNum }]
        : []),
      { key: SA.GateStatus, value: "active" },
    ]);
  }

  while (!shouldContinueAsNew(processed)) {
    const hasWork = await condition(
      () => queue.length > 0 || pendingReGate !== null,
      IDLE_TIMEOUT,
    );
    if (!hasWork) {
      // Idle → complete; a later signal starts a fresh run.
      setGateStatus("idle");
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
    setGateStatus("terminal");
    await notifyParentCompleted();
    return;
  }

  // Hit the history cap with work still pending: roll it into a fresh run (the
  // workflow id and parent link are preserved across Continue-As-New).
  if (queue.length > 0 || pendingReGate !== null) {
    setGateStatus("continued");
    await continueAsNew<typeof prGate>({
      repoId: input.repoId,
      prNumber: input.prNumber,
      pending: queue,
      pendingReGate,
      lastNonce,
    });
  }

  // Cap reached with nothing pending: complete like an idle timeout.
  setGateStatus("idle");
}
