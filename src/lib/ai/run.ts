import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { callModel } from "@/lib/ai/client";
import { modelFor } from "@/lib/ai/models";
import { buildSystem, buildUser, inputHash } from "@/lib/ai/prompt";
import type { AiRunOutcome, AiTask } from "@/lib/ai/types";

/**
 * The one path from "somebody wants an answer" to "there is a validated answer
 * in the database".
 *
 * Order matters and is the whole cost story:
 *
 *   prefilter -> dedupe lookup -> claim -> call -> validate -> persist
 *
 * The prefilter runs before anything touches the database, because the cheapest
 * call is the one never made. The dedupe lookup runs before the claim, because
 * the second person to ask a question should read the first person's answer.
 * The claim runs before the call, because two people asking at the same instant
 * must still only pay once.
 *
 * Nothing here throws for an expected failure. A model that is down, out of
 * credit or talking nonsense is an ordinary condition on this path, and the
 * caller gets a result object saying so. Only a genuine bug throws.
 */

/** How long a RUNNING row may sit before another request may take it over. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export type RunAiTaskArgs<TIn, TOut> = {
  task: AiTask<TIn, TOut>;
  projectId: string;
  subjectKey: string;
  payload: TIn;
  /** Null for an automatic run. Recorded, never used for authorization. */
  triggeredById: string | null;
  /**
   * Force a fresh call even when a stored answer matches. The row is deleted
   * and re-created rather than updated, so the unique constraint keeps doing
   * both of its jobs.
   */
  force?: boolean;
};

export async function runAiTask<TIn, TOut>(
  args: RunAiTaskArgs<TIn, TOut>
): Promise<AiRunOutcome<TOut>> {
  const { task, projectId, subjectKey } = args;

  // 1. Prefilter. The task decides there is nothing worth asking about: the
  //    author already wrote QA steps, the application is three words long, the
  //    diff is a version bump. Costs nothing and is by far the biggest saving.
  const body = task.buildInput(args.payload);
  if (body === null) {
    return { status: "SKIPPED", reason: "prefilter" };
  }

  const model = modelFor(task.tier);
  const system = buildSystem(task);
  const user = buildUser(body);
  const hash = inputHash({
    taskId: task.id,
    promptVersion: task.promptVersion,
    model,
    payload: user,
  });

  const where = {
    taskId_subjectKey_inputHash: { taskId: task.id, subjectKey, inputHash: hash },
  };

  if (args.force) {
    await prisma.aiResult.deleteMany({
      where: { taskId: task.id, subjectKey, inputHash: hash },
    });
  } else {
    // 2. Dedupe. An identical question already answered is free.
    const existing = await prisma.aiResult.findUnique({ where });
    if (existing?.status === "OK" && existing.output) {
      const parsed = task.parse(safeJson(existing.output));
      if (parsed) {
        return { status: "OK", output: parsed, cached: true, usage: null };
      }
      // Stored output no longer satisfies the validator, which means the schema
      // changed without a promptVersion bump. Drop it and re-ask rather than
      // handing a caller something it cannot read.
      await prisma.aiResult.deleteMany({
        where: { taskId: task.id, subjectKey, inputHash: hash },
      });
    } else if (existing?.status === "RUNNING") {
      // Somebody else is already asking. Only take over a claim old enough that
      // its owner must have died: a worker that is killed mid-call would
      // otherwise block this subject forever.
      const age = Date.now() - existing.createdAt.getTime();
      if (age < STALE_CLAIM_MS) {
        return { status: "SKIPPED", reason: "already_running" };
      }
      await prisma.aiResult.deleteMany({
        where: { taskId: task.id, subjectKey, inputHash: hash },
      });
    } else if (existing?.status === "FAILED") {
      // A previous attempt failed. Clear it so this one may proceed: a failure
      // must not poison an input hash permanently.
      await prisma.aiResult.deleteMany({
        where: { taskId: task.id, subjectKey, inputHash: hash },
      });
    }
  }

  // 3. Claim. The unique constraint is the lock. Losing this race means another
  //    request got there first, and paying twice is exactly what we are avoiding.
  let claimId: string;
  try {
    const claimed = await prisma.aiResult.create({
      data: {
        projectId,
        taskId: task.id,
        subjectKey,
        inputHash: hash,
        status: "RUNNING",
        triggeredById: args.triggeredById,
      },
      select: { id: true },
    });
    claimId = claimed.id;
  } catch {
    return { status: "SKIPPED", reason: "already_running" };
  }

  // 4. Call.
  const res = await callModel({
    model,
    system,
    user,
    jsonSchema: task.jsonSchema,
    schemaName: task.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    reasoningEffort: task.reasoningEffort,
  });

  if (!res.ok) {
    await finishFailed(claimId, res.error, res.latencyMs, null);
    Sentry.metrics.count("ai.run.failed", 1, {
      attributes: { task: task.id, kind: res.kind },
    });
    logger.warn(
      { task: task.id, subjectKey, status: res.status, kind: res.kind },
      "ai run failed"
    );
    return { status: "FAILED", error: res.error, retryable: res.kind === "transient" };
  }

  // 5. Validate. A schema-constrained model still returns nonsense sometimes,
  //    and that is a recorded failure rather than an exception. The raw text is
  //    kept only here: it is the only way to debug a drifting prompt, and there
  //    is no reason to store it once the answer parsed.
  const parsed = task.parse(safeJson(res.content));
  if (!parsed) {
    await finishFailed(claimId, "response did not match schema", res.latencyMs, res);
    Sentry.metrics.count("ai.run.failed", 1, {
      attributes: { task: task.id, kind: "schema" },
    });
    logger.warn({ task: task.id, subjectKey }, "ai response failed validation");
    // Not retryable: the same prompt and model will produce the same shape, so
    // a retry burns money to fail again. A person needs to fix the prompt.
    return { status: "FAILED", error: "response did not match schema", retryable: false };
  }

  // 6. Persist.
  await prisma.aiResult.update({
    where: { id: claimId },
    data: {
      status: "OK",
      output: JSON.stringify(parsed),
      modelId: res.model,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      cachedTokens: res.usage.cachedTokens,
      costMicros: res.usage.costMicros,
      latencyMs: res.latencyMs,
      completedAt: new Date(),
    },
  });

  Sentry.metrics.count("ai.run.ok", 1, { attributes: { task: task.id, model: res.model } });
  Sentry.metrics.distribution("ai.run.cost_micros", res.usage.costMicros, {
    attributes: { task: task.id },
  });
  // Cache hit rate is the number that says whether the stable prompt prefix is
  // paying for itself, and it is invisible unless recorded deliberately.
  Sentry.metrics.distribution("ai.run.cached_tokens", res.usage.cachedTokens, {
    attributes: { task: task.id },
  });

  return { status: "OK", output: parsed, cached: false, usage: res.usage };
}

async function finishFailed(
  id: string,
  error: string,
  latencyMs: number,
  res: { content: string; model: string } | null
): Promise<void> {
  await prisma.aiResult
    .update({
      where: { id },
      data: {
        status: "FAILED",
        error: error.slice(0, 500),
        rawOutput: res ? res.content.slice(0, 4000) : null,
        modelId: res?.model ?? null,
        latencyMs,
        completedAt: new Date(),
      },
    })
    // Bookkeeping must not itself throw: the caller already has the real
    // outcome, and losing the audit row is strictly better than losing that.
    .catch(() => undefined);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read the most recent good answer for a subject, without calling anything.
 *
 * This is the render path, and the reason the quality heuristic can stay pure:
 * the verdict is a stored value fetched before scoring, exactly as the account
 * snapshot and the PR template are.
 */
export async function latestAiResult<TOut>(args: {
  task: AiTask<unknown, TOut>;
  subjectKey: string;
}): Promise<{ output: TOut; modelId: string | null; computedAt: Date } | null> {
  const row = await prisma.aiResult.findFirst({
    where: { taskId: args.task.id, subjectKey: args.subjectKey, status: "OK" },
    orderBy: { createdAt: "desc" },
    select: { output: true, modelId: true, completedAt: true, createdAt: true },
  });
  if (!row?.output) return null;
  const parsed = args.task.parse(safeJson(row.output));
  if (!parsed) return null;
  return {
    output: parsed,
    modelId: row.modelId,
    computedAt: row.completedAt ?? row.createdAt,
  };
}
