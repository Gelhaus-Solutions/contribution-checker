import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  ParentClosePolicy,
  setHandler,
  startChild,
  upsertSearchAttributes,
  workflowInfo,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import {
  PROJECT_CLA_SWEEP_INTERVAL_MS,
  PROJECT_RECONCILE_INTERVAL_MS,
  QRY,
  SIG,
  WF,
} from "../../lib/temporal/contracts";
import { SA, type GateStatusValue } from "../../lib/temporal/search-attributes";
import type {
  ProjectConfigChangedPayload,
  ProjectGateInput,
  ProjectGateState,
  ProjectReGateAllPayload,
  ProjectReGateAuthorPayload,
  ProjectRunBackfillPayload,
  ProjectSweepTickPayload,
  ProjectTask,
  QualityBackfillInput,
} from "../../lib/temporal/contracts";

const reGateAll = defineSignal<[ProjectReGateAllPayload]>(SIG.reGateAll);
const reGateAuthor = defineSignal<[ProjectReGateAuthorPayload]>(SIG.reGateAuthor);
const configChanged = defineSignal<[ProjectConfigChangedPayload]>(SIG.configChanged);
const runBackfill = defineSignal<[ProjectRunBackfillPayload]>(SIG.runBackfill);
const sweepTick = defineSignal<[ProjectSweepTickPayload]>(SIG.sweepTick);
const projectGateState = defineQuery<ProjectGateState>(QRY.projectGateState);

/** Hard backstop cap on drained tasks before Continue-As-New; the server's
 * continueAsNewSuggested is the primary trigger. Brand-new workflow, so both
 * triggers ship unpatched. */
const TASKS_BEFORE_CONTINUE = 1000;

/** Page size for the re-gate fan-out (PRs per listReGatePrTargets page /
 * signalReGateBatch call). Bounds both the activity payload and the workflow
 * history: a project with thousands of tracked PRs is O(pages) events. */
const REGATE_PAGE_SIZE = 200;

/** qualityBackfill child id, matching workflowIds.qualityBackfill. Built
 * inline so this module stays import-light. */
function backfillChildId(projectId: string, nonce: string): string {
  return `quality-backfill:${projectId}:${nonce}`;
}

/** Deterministic per-project jitter (djb2 hash) so the fleet of project
 * entities doesn't fire its sweeps in lockstep after a mass bootstrap. */
function projectJitterMs(projectId: string, spreadMs: number): number {
  let h = 5381;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 33 + projectId.charCodeAt(i)) >>> 0;
  }
  return h % spreadMs;
}

function setGateStatus(status: GateStatusValue): void {
  upsertSearchAttributes([{ key: SA.GateStatus, value: status }]);
}

/**
 * Per-project entity workflow (one per project), the top of the
 * project → contributor → pr tree. It:
 *  - owns the durable per-project RECONCILE and CLA sweep timers, replacing
 *    the global reconcileSweep/claSweep crons (each project sweeps on its own
 *    jittered cadence, isolated from slow neighbors);
 *  - absorbs the re-gate fan-out (reGateAll / reGateAuthor / configChanged):
 *    the PR-list query runs as a paged ACTIVITY and each page is signaled by
 *    ONE batched activity, so the fan-out is durable and history stays
 *    O(pages) instead of O(PRs); the shared nonce lets every prGate coalesce
 *    duplicate re-gates; and
 *  - launches the qualityBackfill CHILD on an admin runBackfill signal
 *    (startChild with ParentClosePolicy ABANDON, deterministic nonce id).
 *
 * Unlike the leaf gates it does NOT idle-complete: an active project always
 * has its reconcile timer armed, so the entity lives as long as the project.
 * It retires only when reconcileProject reports the project inactive (no
 * App-mode repos); the ensureProjectGates keepalive schedule signalWithStarts
 * it back if the project becomes active again. Timers and unprocessed tasks
 * are carried across Continue-As-New.
 */
export async function projectGate(input: ProjectGateInput): Promise<void> {
  const tasks: ProjectTask[] = [...(input.pendingTasks ?? [])];
  // First arm spreads projects across the interval; re-arms are exact.
  let reconcileDeadlineMs =
    input.reconcileDeadlineMs ??
    Date.now() +
      projectJitterMs(input.projectId, PROJECT_RECONCILE_INTERVAL_MS) +
      1_000;
  let claDeadlineMs = input.claDeadlineMs ?? null;
  let inactive = false;
  // Bumped by every signal so the wait condition re-evaluates.
  let seq = 0;
  let processed = 0;

  setHandler(reGateAll, (p) => {
    tasks.push({ type: "reGateAll", reason: p.reason, nonce: p.nonce });
    seq++;
  });
  // A config change is a reGateAll task; the distinct signal name keeps the
  // trigger observable in history.
  setHandler(configChanged, (p) => {
    tasks.push({ type: "reGateAll", reason: p.reason, nonce: p.nonce });
    seq++;
  });
  setHandler(reGateAuthor, (p) => {
    tasks.push({
      type: "reGateAuthor",
      ghId: p.ghId ?? null,
      ghLogin: p.ghLogin ?? null,
      reason: p.reason,
      nonce: p.nonce,
    });
    seq++;
  });
  setHandler(runBackfill, (p) => {
    tasks.push({
      type: "runBackfill",
      triggeredById: p.triggeredById,
      limit: p.limit,
      nonce: p.nonce,
    });
    seq++;
  });
  setHandler(sweepTick, () => {
    // Keepalive nudge: waking the loop is the whole point (an elapsed
    // deadline fires below; a fresh start re-arms).
    seq++;
  });
  setHandler(projectGateState, (): ProjectGateState => ({
    projectId: input.projectId,
    queuedTasks: tasks.length,
    queuedKinds: tasks.map((t) => t.type),
    reconcileDeadlineMs,
    claDeadlineMs,
    processed,
  }));

  // Brand-new workflow: no pre-patch histories exist, so the identity upsert
  // ships unguarded.
  upsertSearchAttributes([
    { key: SA.ProjectId, value: input.projectId },
    { key: SA.GateStatus, value: "active" },
  ]);

  while (!shouldContinueAsNew(processed)) {
    // Fire elapsed sweep timers first (idempotent activities; re-arm on fire).
    const now = Date.now();
    if (reconcileDeadlineMs !== null && reconcileDeadlineMs <= now) {
      const res = await acts.reconcileProject(input.projectId);
      if (!res.active) {
        // No App-mode repos left: the entity retires. The ensure schedule
        // signalWithStarts a fresh run if the project becomes active again.
        inactive = true;
        break;
      }
      reconcileDeadlineMs = Date.now() + PROJECT_RECONCILE_INTERVAL_MS;
      // Arm/clear the CLA sweep from the same activity's report.
      if (res.claEnabled && claDeadlineMs === null) {
        claDeadlineMs =
          Date.now() +
          projectJitterMs(input.projectId, PROJECT_CLA_SWEEP_INTERVAL_MS) +
          1_000;
      } else if (!res.claEnabled) {
        claDeadlineMs = null;
      }
      continue;
    }
    if (claDeadlineMs !== null && claDeadlineMs <= now) {
      await acts.claSweepProject(input.projectId);
      claDeadlineMs = Date.now() + PROJECT_CLA_SWEEP_INTERVAL_MS;
      continue;
    }

    // Drain one task.
    if (tasks.length > 0) {
      await runTask(input.projectId, tasks[0]);
      tasks.shift();
      processed += 1;
      continue;
    }

    // Nothing queued: wait until the nearest armed deadline (the reconcile
    // timer is always armed while active, so the entity never idles out).
    const deadlines = [reconcileDeadlineMs, claDeadlineMs].filter(
      (d): d is number => typeof d === "number",
    );
    const nextWake = deadlines.length ? Math.min(...deadlines) : null;
    const observed = seq;
    const pred = () => seq !== observed || tasks.length > 0;
    if (nextWake !== null) {
      await condition(pred, Math.max(0, nextWake - Date.now()));
    } else {
      await condition(pred);
    }
  }

  if (inactive) {
    setGateStatus("terminal");
    return;
  }

  setGateStatus("continued");
  await continueAsNew<typeof projectGate>({
    projectId: input.projectId,
    pendingTasks: tasks,
    reconcileDeadlineMs,
    claDeadlineMs,
  });
}

function shouldContinueAsNew(processed: number): boolean {
  return (
    workflowInfo().continueAsNewSuggested || processed >= TASKS_BEFORE_CONTINUE
  );
}

/** Run a single project-tier task. */
async function runTask(projectId: string, task: ProjectTask): Promise<void> {
  switch (task.type) {
    case "reGateAll":
      await fanOutReGate(projectId, {
        author: null,
        reason: task.reason,
        nonce: task.nonce,
      });
      return;
    case "reGateAuthor":
      await fanOutReGate(projectId, {
        author: { ghId: task.ghId, ghLogin: task.ghLogin },
        reason: task.reason,
        nonce: task.nonce,
      });
      return;
    case "runBackfill": {
      try {
        await startChild(WF.qualityBackfill, {
          workflowId: backfillChildId(projectId, task.nonce),
          parentClosePolicy: ParentClosePolicy.ABANDON,
          args: [
            {
              projectId,
              triggeredById: task.triggeredById,
              limit: task.limit,
            } satisfies QualityBackfillInput,
          ],
        });
      } catch {
        // Same nonce already started (signal re-delivery): dedup by id.
      }
      return;
    }
  }
}

/**
 * Durable, batched re-gate fan-out: page the PR targets via an activity, then
 * signal each page with ONE batched activity that shares the nonce so every
 * prGate coalesces (fast parent path and this completeness path converge).
 */
async function fanOutReGate(
  projectId: string,
  q: {
    author: { ghId: number | null; ghLogin: string | null } | null;
    reason: string;
    nonce: string;
  },
): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: {
      targets: { ghRepoId: number; prNumber: number }[];
      nextCursor: string | null;
    } = await acts.listReGatePrTargets({
      projectId,
      author: q.author,
      cursor,
      limit: REGATE_PAGE_SIZE,
    });
    if (page.targets.length > 0) {
      await acts.signalReGateBatch({
        targets: page.targets,
        reason: q.reason,
        nonce: q.nonce,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}
