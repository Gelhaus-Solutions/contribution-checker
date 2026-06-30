import { condition, continueAsNew, defineSignal, setHandler } from "@temporalio/workflow";
import { acts } from "./proxies";
import { SIG } from "../../lib/temporal/contracts";
import type {
  ClaCoverageChangedPayload,
  ClaStalenessArmedPayload,
  ContributorGateInput,
  ContributorTask,
  CooldownRefreshPayload,
  DecisionChangedPayload,
} from "../../lib/temporal/contracts";

const decisionChanged = defineSignal<[DecisionChangedPayload]>(SIG.decisionChanged);
const claCoverageChanged = defineSignal<[ClaCoverageChangedPayload]>(SIG.claCoverageChanged);
const cooldownRefresh = defineSignal<[CooldownRefreshPayload]>(SIG.cooldownRefresh);
const claStalenessArmed = defineSignal<[ClaStalenessArmedPayload]>(SIG.claStalenessArmed);

/** Continue-As-New after this many drained tasks so a busy contributor never
 * approaches the history ceiling. Timers + queue are carried forward. */
const TASKS_BEFORE_CONTINUE = 1000;

/** Idle window with no armed timer and no work before the entity completes. A
 * later signal simply signalWithStarts a fresh run. */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Per-contributor entity workflow (one per project+author), the middle tier of
 * the project → contributor → pr tree. It owns the contributor's durable
 * cooldown + CLA-staleness timers and runs the application/CLA GitHub fan-out,
 * consolidating what used to be three short workflows (applicationDecision +
 * applicationCooldownTimer + claStalenessTimer).
 *
 * Timers are plain workflow variables checked against a single
 * condition-with-deadline; re-arming is an assignment (no terminate race), and
 * both deadlines are carried across Continue-As-New so a months-long cooldown
 * survives. The elapse activities are idempotent and self-checking, and
 * decideForRepo keeps its own `cooldownUntil > now` check as the final net.
 *
 * Completes when there is no pending work and no armed timer for IDLE_TIMEOUT_MS.
 */
export async function contributorGate(input: ContributorGateInput): Promise<void> {
  const tasks: ContributorTask[] = [...(input.pendingTasks ?? [])];
  let cooldown = input.cooldown ?? null;
  let staleness = input.staleness ?? null;
  // Bumped by every signal so the wait condition re-evaluates (recomputing the
  // next deadline) instead of sleeping through a freshly-armed timer.
  let seq = 0;

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

  let processed = 0;
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

    // Drain one fan-out task.
    if (tasks.length > 0) {
      const armed = await runTask(input, tasks[0]);
      // A decision/refresh re-reads the application's cooldown; (re)arm or clear.
      if (armed !== undefined) cooldown = armed;
      tasks.shift();
      processed += 1;
      continue;
    }

    // Nothing to do now: wait until the nearest armed deadline, or the idle
    // window if nothing is armed (→ complete).
    const deadlines = [cooldown?.deadlineMs, staleness?.deadlineMs].filter(
      (d): d is number => typeof d === "number",
    );
    const nextWake = deadlines.length ? Math.min(...deadlines) : null;
    const waitMs = nextWake !== null ? Math.max(0, nextWake - Date.now()) : IDLE_TIMEOUT_MS;
    const observed = seq;
    const woke = await condition(() => seq !== observed || tasks.length > 0, waitMs);
    // Idle timeout with nothing armed and nothing queued → complete.
    if (!woke && nextWake === null) return;
  }

  await continueAsNew<typeof contributorGate>({
    projectId: input.projectId,
    authorGhId: input.authorGhId,
    pendingTasks: tasks,
    cooldown,
    staleness,
  });
}

/**
 * Run a single fan-out task. Returns the (re)computed cooldown arm for a
 * decision/refresh task (or null to clear); returns undefined for tasks that
 * don't touch the cooldown, leaving the current arm in place.
 */
async function runTask(
  input: ContributorGateInput,
  task: ContributorTask,
): Promise<{ applicationId: string; deadlineMs: number } | null | undefined> {
  switch (task.type) {
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

/** Read the application's current cooldown and translate it into an arm. */
async function readCooldown(
  applicationId: string,
): Promise<{ applicationId: string; deadlineMs: number } | null> {
  const iso = await acts.readApplicationCooldown(applicationId);
  if (!iso) return null;
  return { applicationId, deadlineMs: Date.parse(iso) };
}
