import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  ParentClosePolicy,
  patched,
  setHandler,
  startChild,
  upsertSearchAttributes,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import { PATCHES, QRY, SIG, WF } from "../../lib/temporal/contracts";
import { SA, type GateStatusValue } from "../../lib/temporal/search-attributes";
import type {
  ClaCoverageChangedPayload,
  ClaStalenessArmedPayload,
  ContributorGateInput,
  ContributorGateState,
  ContributorPrEvent,
  ContributorTask,
  CooldownRefreshPayload,
  DecisionChangedPayload,
  PrChildCompletedPayload,
  PrGateInput,
} from "../../lib/temporal/contracts";

const prEvent = defineSignal<[ContributorPrEvent]>(SIG.prEvent);
const prChildCompleted = defineSignal<[PrChildCompletedPayload]>(SIG.prChildCompleted);
const decisionChanged = defineSignal<[DecisionChangedPayload]>(SIG.decisionChanged);
const claCoverageChanged = defineSignal<[ClaCoverageChangedPayload]>(SIG.claCoverageChanged);
const cooldownRefresh = defineSignal<[CooldownRefreshPayload]>(SIG.cooldownRefresh);
const claStalenessArmed = defineSignal<[ClaStalenessArmedPayload]>(SIG.claStalenessArmed);
const contributorGateState = defineQuery<ContributorGateState>(QRY.contributorGateState);

/** Continue-As-New after this many drained tasks so a busy contributor never
 * approaches the history ceiling. Timers + queue + live children are carried. */
const TASKS_BEFORE_CONTINUE = 1000;

/** Idle window with no armed timer, no work, and no live children before the
 * entity completes. A later signal simply signalWithStarts a fresh run. */
const IDLE_TIMEOUT_MS = 60_000;

/** The prGate child workflow id, matching workflowIds.pullRequest. Built inline
 * (not via the task-queue helper) so this module stays import-light for the
 * deterministic workflow bundle. */
function prChildId(ghRepoId: string, prNumber: number): string {
  return `pr:${ghRepoId}:${prNumber}`;
}

/** Update the GateStatus search attribute. upsert emits a command, so every
 * call is behind the search-attrs patch: a history recorded before the patch
 * replays without the command and stays deterministic. */
function setGateStatus(status: GateStatusValue): void {
  if (!patched(PATCHES.contributorGateSearchAttrs)) return;
  upsertSearchAttributes([{ key: SA.GateStatus, value: status }]);
}

/**
 * Per-contributor entity workflow (one per project+author), the middle tier of
 * the project → contributor → pr tree. It:
 *  - routes the contributor's GitHub PR events to per-PR prGate CHILDREN
 *    (startChild with ParentClosePolicy ABANDON, so the Relationships tab shows
 *    contributor → pr and a child outlives the parent);
 *  - owns the contributor's durable cooldown + CLA-staleness timers; and
 *  - runs the application/CLA GitHub fan-out (consolidating the old
 *    applicationDecision + applicationCooldownTimer + claStalenessTimer).
 *
 * Timers are plain workflow variables checked against a single
 * condition-with-deadline; re-arming is an assignment (no terminate race) and
 * deadlines are carried across Continue-As-New so a months-long cooldown
 * survives. Children are signaled via external handles (works across CAN); a
 * child reports `prChildCompleted` when it ends so the parent drops it. The gate
 * stays alive while any child is live and completes only once all report done
 * (an ABANDON child is therefore never orphaned by the parent idling out).
 */
export async function contributorGate(input: ContributorGateInput): Promise<void> {
  const tasks: ContributorTask[] = [...(input.pendingTasks ?? [])];
  const liveChildren = new Set<string>(input.liveChildren ?? []);
  let cooldown = input.cooldown ?? null;
  let staleness = input.staleness ?? null;
  // Bumped by every signal so the wait condition re-evaluates (recomputing the
  // next deadline / noticing a completed child) instead of sleeping through it.
  let seq = 0;
  let processed = 0;

  setHandler(prEvent, (p) => {
    tasks.push({ type: "prEvent", ghRepoId: p.ghRepoId, prNumber: p.prNumber, envelope: p.envelope });
    seq++;
  });
  setHandler(prChildCompleted, (p) => {
    liveChildren.delete(p.childWorkflowId);
    seq++;
  });
  setHandler(decisionChanged, (p) => {
    tasks.push({ type: "decision", kind: p.kind, applicationId: p.applicationId, args: p.args });
    seq++;
  });
  setHandler(claCoverageChanged, (p) => {
    tasks.push({ type: "cla", direction: p.direction });
    if (p.recheckAtIso) staleness = { deadlineMs: Date.parse(p.recheckAtIso) };
    seq++;
  });
  setHandler(cooldownRefresh, (p) => {
    tasks.push({ type: "cooldownRefresh", applicationId: p.applicationId });
    seq++;
  });
  setHandler(claStalenessArmed, (p) => {
    staleness = { deadlineMs: Date.parse(p.atIso) };
    seq++;
  });
  // Ops/debugging read of the gate's durable state. Pure closure read (fresh
  // arrays via spread/map): never mutates, never emits commands.
  setHandler(contributorGateState, (): ContributorGateState => ({
    projectId: input.projectId,
    authorGhId: input.authorGhId,
    queuedTasks: tasks.length,
    queuedKinds: tasks.map((t) => t.type),
    liveChildren: [...liveChildren],
    cooldown,
    staleness,
    processed,
  }));

  // Identity attributes so the execution is findable in the Temporal UI by
  // project/contributor/status (also re-established after Continue-As-New).
  if (patched(PATCHES.contributorGateSearchAttrs)) {
    upsertSearchAttributes([
      { key: SA.ProjectId, value: input.projectId },
      { key: SA.ContributorGhId, value: input.authorGhId },
      { key: SA.GateStatus, value: "active" },
    ]);
  }

  while (processed < TASKS_BEFORE_CONTINUE) {
    // Fire any elapsed timers first (idempotent activities; clear once fired).
    const now = Date.now();
    if (cooldown && cooldown.deadlineMs <= now) {
      await acts.elapseApplicationCooldown(cooldown.applicationId);
      cooldown = null;
    }
    if (staleness && staleness.deadlineMs <= now) {
      await acts.claSweepProject(input.projectId);
      staleness = null;
    }

    // Drain one task.
    if (tasks.length > 0) {
      const armed = await runTask(input, tasks[0], liveChildren);
      // A decision/refresh re-reads the application's cooldown; (re)arm or clear.
      if (armed !== undefined) cooldown = armed;
      tasks.shift();
      processed += 1;
      continue;
    }

    // Nothing queued: wait until the nearest armed deadline; or, if a child is
    // still live, indefinitely for it to report (or new work); else the idle
    // window (→ complete).
    const deadlines = [cooldown?.deadlineMs, staleness?.deadlineMs].filter(
      (d): d is number => typeof d === "number",
    );
    const nextWake = deadlines.length ? Math.min(...deadlines) : null;
    const observed = seq;
    const pred = () => seq !== observed || tasks.length > 0;
    if (nextWake !== null) {
      await condition(pred, Math.max(0, nextWake - Date.now()));
    } else if (liveChildren.size > 0) {
      await condition(pred); // stay alive for the children; no idle completion
    } else {
      const woke = await condition(pred, IDLE_TIMEOUT_MS);
      if (!woke) {
        // Idle, nothing armed, no children → complete.
        setGateStatus("idle");
        return;
      }
    }
  }

  setGateStatus("continued");
  await continueAsNew<typeof contributorGate>({
    projectId: input.projectId,
    authorGhId: input.authorGhId,
    pendingTasks: tasks,
    cooldown,
    staleness,
    liveChildren: [...liveChildren],
  });
}

/**
 * Run a single task. Returns the (re)computed cooldown arm for a
 * decision/refresh task (or null to clear); returns undefined for tasks that
 * don't touch the cooldown, leaving the current arm in place.
 */
async function runTask(
  input: ContributorGateInput,
  task: ContributorTask,
  liveChildren: Set<string>,
): Promise<{ applicationId: string; deadlineMs: number } | null | undefined> {
  switch (task.type) {
    case "prEvent":
      await deliverPrEvent(task, liveChildren);
      return undefined;
    case "decision": {
      await acts.runApplicationPostDecision({
        kind: task.kind,
        applicationId: task.applicationId,
        args: task.args,
      });
      return readCooldown(task.applicationId);
    }
    case "cooldownRefresh":
      return readCooldown(task.applicationId);
    case "cla":
      await acts.applyClaCoverageChange({
        projectId: input.projectId,
        ghId: input.authorGhId,
        direction: task.direction,
      });
      return undefined;
  }
}

/**
 * Deliver a PR event to its prGate child: signal the live child, else start it
 * as a child (establishing the tree). Robust to the child having just completed
 * (re-create) or already running top-level / from a race (adopt + external
 * signal).
 */
async function deliverPrEvent(
  task: Extract<ContributorTask, { type: "prEvent" }>,
  liveChildren: Set<string>,
): Promise<void> {
  const childId = prChildId(task.ghRepoId, task.prNumber);

  if (liveChildren.has(childId)) {
    try {
      await getExternalWorkflowHandle(childId).signal(SIG.githubEvent, task.envelope);
      return;
    } catch {
      // Child already completed; drop and re-create below.
      liveChildren.delete(childId);
    }
  }

  const args: PrGateInput = {
    repoId: task.ghRepoId,
    prNumber: task.prNumber,
    first: task.envelope,
  };
  try {
    await startChild(WF.prGate, {
      workflowId: childId,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [args],
    });
    liveChildren.add(childId);
  } catch {
    // Already running (started top-level by a re-gate, or a concurrent start):
    // adopt it logically and deliver the event via an external signal.
    liveChildren.add(childId);
    try {
      await getExternalWorkflowHandle(childId).signal(SIG.githubEvent, task.envelope);
    } catch {
      // Best-effort; a later event or the reconcile sweep will re-converge.
    }
  }
}

/** Read the application's current cooldown and translate it into an arm. */
async function readCooldown(
  applicationId: string,
): Promise<{ applicationId: string; deadlineMs: number } | null> {
  const iso = await acts.readApplicationCooldown(applicationId);
  if (!iso) return null;
  return { applicationId, deadlineMs: Date.parse(iso) };
}
