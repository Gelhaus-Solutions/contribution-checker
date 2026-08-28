import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";
import { costMicrosFor } from "@/lib/ai/models";
import type { AiCallResult } from "@/lib/ai/types";

/**
 * The only place this app talks to OpenRouter.
 *
 * Everything above it (the task catalog, the orchestrator, the four features)
 * is pure or database-bound, which is what makes the subsystem testable: unit
 * tests mock this one module and never touch the network. Keep it that way. If
 * a second call site ever appears, it belongs in here as another function
 * rather than as a second fetch somewhere else.
 *
 * The contract deliberately mirrors `deliverOutboundAttempt` in
 * `src/worker/activities/webhook-delivery.ts`: provider-said-no is a returned
 * result, not a thrown error, so the caller classifies and the workflow owns
 * the retry decision. Only genuine programming errors throw.
 */

/** Status codes where retrying cannot help. */
const TERMINAL_STATUSES = new Set([
  400, // malformed request: our bug, retrying repeats it
  401, // bad or missing key
  402, // out of credit, or over the account's spend limit
  403, // key not permitted this model (e.g. not on the account's allowlist)
  404, // no such model
  422,
]);

export type AiCallArgs = {
  model: string;
  /** The fixed, cacheable half of the prompt. See prompt.ts. */
  system: string;
  /** The variable half: the actual subject being asked about. */
  user: string;
  jsonSchema: Record<string, unknown>;
  /** Schema name sent to the provider; shows up in provider-side logs. */
  schemaName: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

/**
 * Call the model and return its raw text content.
 *
 * Parsing and validation are the caller's job: this returns whatever came back
 * so the orchestrator can record the raw text on a validation failure, which is
 * the only way to debug a prompt that has started drifting.
 */
export async function callModel(args: AiCallArgs): Promise<AiCallResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  // Resolved here rather than passed in, so the key never becomes a function
  // argument that could be logged, serialized into Temporal history, or end up
  // in a Sentry breadcrumb. Same rule the GitHub App key follows.
  const apiKey = await getSecret("OPENROUTER_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      kind: "terminal",
      status: null,
      error: "OPENROUTER_API_KEY is not configured",
      latencyMs: elapsed(),
    };
  }

  let res: Response;
  try {
    res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution on its model-usage rankings.
        // Derived from config we already have, so no new env var.
        "HTTP-Referer": env.PUBLIC_BASE_URL,
        "X-Title": "Contribution Checker",
      },
      body: JSON.stringify({
        model: args.model,
        // System first, then user. The provider caches on a prefix match, so
        // the invariant half has to come first or nothing is ever cacheable.
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        // Deterministic-ish: these are classification and summarization tasks
        // where creative variation is a defect, and a stable answer means the
        // content-hash dedupe is actually worth something.
        temperature: 0,
        max_tokens: args.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: args.schemaName,
            strict: true,
            schema: args.jsonSchema,
          },
        },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (e) {
    // Timeout, DNS, socket. All plausibly transient.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      kind: "transient",
      status: null,
      error: msg.slice(0, 500),
      latencyMs: elapsed(),
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // A body we cannot read does not change the classification.
    }
    return {
      ok: false,
      kind: TERMINAL_STATUSES.has(res.status) ? "terminal" : "transient",
      status: res.status,
      error: detail || `HTTP ${res.status}`,
      latencyMs: elapsed(),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      kind: "transient",
      status: res.status,
      error: "response was not JSON",
      latencyMs: elapsed(),
    };
  }

  const parsed = readCompletion(body);
  if (!parsed) {
    return {
      ok: false,
      kind: "transient",
      status: res.status,
      error: "response had no message content",
      latencyMs: elapsed(),
    };
  }

  // The model actually used, which can differ from the one asked for when
  // OpenRouter falls back between providers. Recorded so a cost line can be
  // reconciled against the provider dashboard.
  const model = parsed.model || args.model;
  return {
    ok: true,
    content: parsed.content,
    model,
    usage: {
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      cachedTokens: parsed.cachedTokens,
      costMicros: costMicrosFor({
        model,
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        cachedTokens: parsed.cachedTokens,
      }),
    },
    latencyMs: elapsed(),
  };
}

type Completion = {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
};

/**
 * Pull the pieces we need out of an OpenAI-shaped chat completion.
 *
 * Written defensively on purpose. This is the boundary with a third party whose
 * response shape we do not control, and every field here is optional in at
 * least one provider's implementation. A missing usage block costs us a cost
 * figure; it must never cost us the answer.
 */
function readCompletion(body: unknown): Completion | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const choices = Array.isArray(b.choices) ? b.choices : null;
  const first = choices?.[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.length === 0) return null;

  const usage =
    b.usage && typeof b.usage === "object" ? (b.usage as Record<string, unknown>) : null;
  const details =
    usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;

  return {
    content,
    model: typeof b.model === "string" ? b.model : "",
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens),
    cachedTokens: num(details?.cached_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}
