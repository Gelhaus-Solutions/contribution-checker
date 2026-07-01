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
  if (isRateLimited(e)) return e; // transient: retry with backoff
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
