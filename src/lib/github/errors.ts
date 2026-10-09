import { ApplicationFailure } from "@temporalio/common";

/**
 * Temporal-facing GitHub error classification, used ONLY at activity
 * boundaries (src/worker/activities/*). It maps permanent GitHub failures to
 * non-retryable ApplicationFailures so they surface immediately instead of
 * burning the full 8-attempt retry policy, while transient failures re-throw
 * unchanged and keep the SDK's backoff.
 *
 * Deliberately NOT wired into the shared lib/github handlers: those are also
 * called from non-Temporal paths (CI route, server actions) where an
 * ApplicationFailure type would be noise. Must never be imported by workflow
 * code (it is activity-side, non-deterministic land).
 */

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/** A 403 is ambiguous on GitHub: permission denied (permanent) vs primary or
 * secondary rate limiting (transient). Treat it as rate limiting when the
 * response says so. */
function isRateLimited(e: unknown): boolean {
  const s = statusOf(e);
  if (s === 429) return true;
  if (s !== 403) return false;
  const headers = (
    e as { response?: { headers?: Record<string, unknown> } }
  )?.response?.headers;
  if (!headers) return false;
  return (
    headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] != null
  );
}

const MIN_RATE_LIMIT_DELAY_MS = 1_000;
/** Cap so one attempt never sleeps past what a deploy or a lifted limit makes
 * pointless; the next attempt re-checks and sleeps again if still limited. */
const MAX_RATE_LIMIT_DELAY_MS = 30 * 60 * 1000;

/** How long until GitHub (or our own budget) will accept this request again,
 * from `retry-after` or `x-ratelimit-reset`. Null when the error says nothing. */
export function rateLimitDelayMs(e: unknown, now = Date.now()): number | null {
  const headers = (
    e as { response?: { headers?: Record<string, unknown> } }
  )?.response?.headers;
  if (!headers) return null;
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] != null && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (headers["x-ratelimit-reset"] != null && Number.isFinite(reset)) {
    return reset * 1000 - now;
  }
  return null;
}

function rateLimitedFailure(e: unknown): unknown {
  const delay = rateLimitDelayMs(e);
  if (delay == null) return e;
  const detail = e instanceof Error ? e.message : String(e);
  return ApplicationFailure.create({
    message: `github rate limited: ${detail}`,
    type: "GithubRateLimited",
    nonRetryable: false,
    nextRetryDelay: Math.min(
      MAX_RATE_LIMIT_DELAY_MS,
      Math.max(MIN_RATE_LIMIT_DELAY_MS, delay)
    ),
    cause: e instanceof Error ? e : undefined,
  });
}

/** Statuses where a retry can never succeed: revoked/expired installation
 * token (401), resource gone (404/410), malformed request (422). */
const PERMANENT_STATUSES = new Set([401, 404, 410, 422]);

/**
 * Re-throw a caught GitHub/Octokit error with retry classification applied:
 * permanent failures become non-retryable ApplicationFailures (with a stable
 * `type` for the Temporal UI), everything else re-throws as-is so the
 * activity retry policy handles it. Usage:
 *
 *   try { await doGithubThing(); } catch (e) { throw classifyGithubError(e); }
 */
export function classifyGithubError(e: unknown): unknown {
  if (e instanceof ApplicationFailure) return e; // already classified upstream
  // Transient, and the one case where we know when a retry can work: not
  // before the window resets. Without this the SDK's own schedule (2s doubling
  // to 2 minutes, 8 attempts) gives up long before an hourly quota comes back.
  if (isRateLimited(e)) return rateLimitedFailure(e);
  const s = statusOf(e);
  if (s == null) return e; // network/unknown: retry
  if (s >= 500) return e; // GitHub 5xx: retry
  const detail = e instanceof Error ? e.message : String(e);
  if (s === 403) {
    return ApplicationFailure.nonRetryable(
      `github 403 (permission denied): ${detail}`,
      "GithubForbidden"
    );
  }
  if (PERMANENT_STATUSES.has(s)) {
    return ApplicationFailure.nonRetryable(
      `github ${s}: ${detail}`,
      `Github${s}`
    );
  }
  return e;
}
