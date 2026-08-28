/**
 * Public types for the AI subsystem.
 *
 * The shape here deliberately mirrors `src/lib/quality/types.ts`: a catalog of
 * tasks with stable ids, each carrying its own defaults, so the settings UI can
 * render from the catalog and adding a task needs no migration and no UI work.
 * `ALL_AI_TASKS` is to this module what `ALL_HEURISTICS` is to quality scoring.
 *
 * Nothing in here imports Prisma, the OpenRouter client or `server-only`, so a
 * task definition stays a plain value that unit tests can exercise directly.
 */

/**
 * Which model a task runs on.
 *
 * Only one of the four tasks does real synthesis (the release narrative), so
 * only one needs the expensive model. The rest are short-context, constrained
 * JSON classification and summarization, which is the regime where a small
 * model sits closest to a large one. Splitting them is worth roughly 8x on the
 * per-call price.
 */
export type AiTier = "cheap" | "judgment";

/** Terminal state of a single run. Mirrors `AiResult.status`. */
export type AiRunStatus = "RUNNING" | "OK" | "FAILED";

/**
 * Token and money accounting for one call, read back off the provider response
 * rather than estimated. `cachedTokens` is the portion of the prompt that hit
 * the provider's prompt cache: those bill at roughly a tenth of fresh input, so
 * it is the number that tells us whether the stable-prefix layout in prompt.ts
 * is actually earning anything.
 */
export type AiUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Cost in millionths of a dollar. Integer, so it sums without float drift. */
  costMicros: number;
};

/**
 * What the client returns. Deliberately a result object rather than a thrown
 * error for the provider-said-no cases, following the `OutboundAttemptResult`
 * precedent in `src/worker/activities/webhook-delivery.ts`: the caller decides
 * what is retryable, and the workflow stays in charge of retries.
 */
export type AiCallResult =
  | { ok: true; content: string; model: string; usage: AiUsage; latencyMs: number }
  | {
      ok: false;
      /**
       * `terminal` means retrying cannot help: a bad key, an exhausted budget,
       * a malformed request, a model the account may not call. `transient`
       * means a retry plausibly succeeds: 429, 5xx, a timeout, a socket error.
       */
      kind: "terminal" | "transient";
      status: number | null;
      error: string;
      latencyMs: number;
    };

/**
 * A single AI capability: the prompt, the schema its answer must satisfy, and
 * the rules for when it is worth calling at all.
 *
 * `TIn` is the caller-supplied payload, `TOut` the validated answer.
 */
export type AiTask<TIn = unknown, TOut = unknown> = {
  /** Stable id, namespaced by surface. Persisted in `AiResult.taskId`. */
  id: string;
  label: string;
  description: string;
  tier: AiTier;
  /**
   * Bump when the prompt or schema changes in a way that invalidates stored
   * answers. It feeds the input hash, so a bump re-runs every subject on next
   * request instead of serving an answer built by the old prompt.
   */
  promptVersion: number;
  /**
   * Off for every task initially. Turning the subsystem on for a project must
   * not silently start spending on four surfaces at once.
   */
  defaultEnabled: boolean;
  /**
   * The fixed half of the prompt: role, rules, and the shape of the answer.
   * Must not interpolate anything variable, or the provider's prompt cache
   * misses on every call. See the comment in prompt.ts.
   */
  system: string;
  /**
   * JSON Schema the response must satisfy, sent as `response_format`.
   *
   * Hand-written next to `parse` rather than generated from the zod validator.
   * It is part of the cached prefix, so it has to be byte-stable across
   * releases, and a generator would let a dependency upgrade silently reword it
   * and bust the cache for every project at once.
   */
  jsonSchema: Record<string, unknown>;
  /**
   * Render the variable half of the prompt. Returning null means "not worth
   * asking": the deterministic prefilter already knows the answer, or there is
   * too little input to judge. A null here is the cheapest possible outcome,
   * because it costs no call at all.
   */
  buildInput(payload: TIn): string | null;
  /**
   * Validate the model's answer. Returns null on anything unexpected, which the
   * orchestrator records as a failed run. Never throws: a model returning
   * nonsense is an ordinary Tuesday, not an exception.
   */
  parse(raw: unknown): TOut | null;
};

/** What `runAiTask` gives back. */
export type AiRunOutcome<TOut = unknown> =
  | { status: "OK"; output: TOut; cached: boolean; usage: AiUsage | null }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; error: string; retryable: boolean };

/**
 * The stored AI verdict about one PR, as read back onto `PrContext` for the
 * quality heuristic. Deliberately small: the heuristic reads a number and a
 * short reason, and never sees the full narrative.
 */
export type AiVerdict = {
  /** 0-100, the model's own view of description quality and scope coherence. */
  assessment: number;
  reason: string;
  modelId: string;
  computedAt: string;
};
