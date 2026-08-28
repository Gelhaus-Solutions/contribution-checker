import { qaStepsTask } from "@/lib/ai/tasks/qa-steps";
import { triageTask } from "@/lib/ai/tasks/triage";
import type { AiTask, AiTaskSetting } from "@/lib/ai/types";

/**
 * The AI task catalog.
 *
 * Exactly the bargain `ALL_HEURISTICS` makes in src/lib/quality/registry.ts and
 * `DIGEST_SECTIONS` makes in staging-digest.ts: adding a task here makes its
 * settings checkbox appear with no further UI work and no migration, because
 * `AiResult.taskId` is a plain string and `Project.aiConfig` is a sparse map.
 * Retiring one is equally cheap: `parseAiConfig` drops ids it does not know, so
 * a stale override cannot resurrect a task that no longer exists.
 *
 * The `unknown` type arguments are deliberate. Each task is strongly typed at
 * its own definition and at its call site; this array only needs to be iterable
 * for the settings UI, which reads labels and ids and nothing else.
 */
export const ALL_AI_TASKS: AiTask<never, unknown>[] = [
  triageTask as unknown as AiTask<never, unknown>,
  qaStepsTask as unknown as AiTask<never, unknown>,
];

export const AI_TASK_BY_ID = new Map<string, AiTask<never, unknown>>(
  ALL_AI_TASKS.map((t) => [t.id, t])
);

export const ALL_AI_TASK_IDS = ALL_AI_TASKS.map((t) => t.id);

/**
 * Whether a task may run for a project.
 *
 * Two gates, both of which must pass. `aiEnabled` is the project-wide switch, so
 * one toggle turns the whole subsystem off without editing per-task state. The
 * per-task override then falls back to the task's own default, which is false
 * for everything: enabling AI on a project must not start four features at once.
 */
export function isAiTaskEnabled(
  task: Pick<AiTask, "id" | "defaultEnabled">,
  project: { aiEnabled: boolean },
  config: Record<string, AiTaskSetting>
): boolean {
  if (!project.aiEnabled) return false;
  const override = config[task.id];
  return override ? override.enabled : task.defaultEnabled;
}
