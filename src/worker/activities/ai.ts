import { ApplicationFailure } from "@temporalio/activity";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { parseAiConfig } from "@/lib/ai/config";
import { AI_TASK_BY_ID, isAiTaskEnabled } from "@/lib/ai/registry";
import { runAiTask } from "@/lib/ai/run";
import { subjectKeys } from "@/lib/ai/prompt";
import { triageTask } from "@/lib/ai/tasks/triage";
import { parseFormSchema } from "@/lib/applications/schema";
import type { AiRunInput, AiRunResultPayload } from "@/lib/temporal/contracts";

/**
 * Run one AI task.
 *
 * Everything the model needs is loaded here rather than passed in, which is the
 * same rule the QA board sync and the outbound webhook activity follow: the API
 * key, and the contributor-written text the prompt is built from, must not enter
 * workflow history. The workflow carries ids.
 *
 * Terminal failures are raised as a non-retryable `AiTerminalError` so the
 * retry policy in ../workflows/ai.ts stops immediately. That distinction is
 * money: retrying an out-of-credit or schema-violating call three times costs
 * three calls to learn the same thing.
 */
export async function runAiTaskActivity(input: AiRunInput): Promise<AiRunResultPayload> {
  const task = AI_TASK_BY_ID.get(input.taskId);
  if (!task) {
    throw ApplicationFailure.nonRetryable(
      `unknown ai task ${input.taskId}`,
      "AiTerminalError"
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, aiEnabled: true, aiConfig: true },
  });
  if (!project) {
    throw ApplicationFailure.nonRetryable("project not found", "AiTerminalError");
  }

  // Re-checked here and not only at the button, because the setting can be
  // turned off between the click and the run, and because an automatic trigger
  // has no button at all.
  const config = parseAiConfig(project.aiConfig);
  if (!isAiTaskEnabled(task, project, config)) {
    return { status: "SKIPPED", reason: "task_disabled" };
  }

  const loaded = await loadPayload(input);
  if (!loaded) return { status: "SKIPPED", reason: "subject_missing" };

  const result = await runAiTask({
    task,
    projectId: project.id,
    subjectKey: loaded.subjectKey,
    payload: loaded.payload as never,
    triggeredById: input.triggeredById,
    force: input.force,
  });

  if (result.status === "OK") {
    // Audited only when a call actually happened. A cache hit is not an event:
    // auditing it would fill the log with rows saying nothing changed.
    if (!result.cached) {
      await recordAudit({
        projectId: project.id,
        actorId: input.triggeredById,
        kind: "ai.run_completed",
        payload: {
          taskId: task.id,
          subjectKey: loaded.subjectKey,
          costMicros: result.usage?.costMicros ?? 0,
        },
      }).catch(() => undefined);
    }
    return {
      status: "OK",
      cached: result.cached,
      costMicros: result.usage?.costMicros ?? 0,
    };
  }

  if (result.status === "SKIPPED") return result;

  await recordAudit({
    projectId: project.id,
    actorId: input.triggeredById,
    kind: "ai.run_failed",
    payload: { taskId: task.id, subjectKey: loaded.subjectKey, error: result.error },
  }).catch(() => undefined);

  if (!result.retryable) {
    logger.warn(
      { taskId: task.id, subjectKey: loaded.subjectKey },
      "ai run failed terminally"
    );
    throw ApplicationFailure.nonRetryable(result.error, "AiTerminalError");
  }
  // Transient: throwing lets the workflow's retry policy have its three goes.
  throw new Error(result.error);
}

type Loaded = { subjectKey: string; payload: unknown };

/**
 * Build the model input for a subject.
 *
 * One function rather than a method on the task, because loading is I/O and the
 * task definitions are deliberately pure values that a unit test can exercise
 * without a database.
 */
async function loadPayload(input: AiRunInput): Promise<Loaded | null> {
  switch (input.taskId) {
    case triageTask.id: {
      const app = await prisma.application.findFirst({
        where: { id: input.subjectId, projectId: input.projectId },
        select: { id: true, answers: true, project: { select: { formSchema: true } } },
      });
      if (!app) return null;
      return {
        subjectKey: subjectKeys.application(app.id),
        payload: {
          fields: parseFormSchema(app.project.formSchema),
          answers: safeAnswers(app.answers),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * `Application.answers` is a JSON string. Parsed tolerantly for the same reason
 * every other JSON column in this codebase is: a row written by an older schema
 * must degrade to "no answers" rather than break the run.
 */
function safeAnswers(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}
