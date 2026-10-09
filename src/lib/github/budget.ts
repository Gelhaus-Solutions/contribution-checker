import { AsyncLocalStorage } from "node:async_hooks";

/**
 * GitHub request budget: two lanes sharing one installation quota.
 *
 * An installation gets one hourly quota (6850 on the large installs, 5000
 * otherwise) no matter how many things are spending it. Left alone, the loudest
 * spender wins: a reconcile sweep, a staging sync or a re-gate fan-out can burn
 * the whole hour and every webhook after that fails with "API rate limit
 * exceeded", which is how a CLA check went missing on a live PR.
 *
 *   - `interactive` (75%): the production path. Webhook handling, gate
 *     decisions, check runs, labels, comments: small, latency-sensitive calls.
 *   - `bulk` (25%): reconciliation, syncs, backfills, fan-outs and the large
 *     reads (compare, repo-wide PR listings). Work that is re-derived on the
 *     next pass anyway, so it can wait for the next window.
 *
 * Bulk is **capped** at its share and must also leave the interactive share
 * untouched, so a quiet hour for webhooks does not let a sweep eat into it.
 * Interactive is **reserved** rather than capped: it may spill into whatever
 * bulk has not used, because refusing a webhook while a quarter of the quota
 * sits idle helps nobody. It stops only when GitHub itself says the quota is
 * gone, and then it stops *before* sending, rather than hammering a limit that
 * GitHub treats as abuse.
 *
 * REST (`core`) and GraphQL are separate quotas on GitHub's side, so each gets
 * its own window per installation. Search has its own tiny per-minute quota and
 * is not accounted here.
 *
 * Counters live in this process; GitHub's own `x-ratelimit-remaining` header is
 * the cross-process truth and is folded in on every response. The worker does
 * essentially all of the GitHub traffic, and a second process can only make bulk
 * stop earlier (it reserves the interactive share against what *this* process
 * saw), never later.
 *
 * Pure and dependency-free on purpose: no logger, no prisma.
 */

export type BudgetLane = "interactive" | "bulk";
export type BudgetResource = "core" | "graphql";

/** Share of an installation's quota the bulk lane may spend. */
export const BULK_SHARE = 0.25;

const DEFAULT_LIMIT = 5000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_WINDOWS = 2000;

const laneStore = new AsyncLocalStorage<BudgetLane>();

/** Run `fn` with every GitHub request it makes (transitively) in `lane`. */
export function runInLane<T>(lane: BudgetLane, fn: () => Promise<T>): Promise<T> {
  return laneStore.run(lane, fn);
}

/** Mark background work: reconcile, sync, backfill, fan-out. */
export function inBulkLane<T>(fn: () => Promise<T>): Promise<T> {
  return runInLane("bulk", fn);
}

export function currentLane(): BudgetLane | undefined {
  return laneStore.getStore();
}

/**
 * Thrown instead of sending a request the budget refuses. Shaped like an
 * Octokit rate-limit error (status 429, `retry-after`), so every existing
 * rate-limit check treats it as transient and `classifyGithubError` lets the
 * activity retry with backoff instead of failing it for good.
 */
export class GithubBudgetError extends Error {
  readonly status = 429;
  readonly response: { headers: Record<string, string> };
  constructor(
    readonly lane: BudgetLane,
    readonly resource: BudgetResource,
    readonly retryAfterSeconds: number,
    reason: string,
  ) {
    super(
      `github ${resource} budget exhausted for the ${lane} lane (${reason}); retry in ${retryAfterSeconds}s`,
    );
    this.name = "GithubBudgetError";
    this.response = { headers: { "retry-after": String(retryAfterSeconds) } };
  }
}

export function isBudgetError(e: unknown): e is GithubBudgetError {
  return e instanceof GithubBudgetError;
}

type Window = {
  limit: number;
  /** GitHub's last word on what is left, or null before the first response. */
  remaining: number | null;
  /** When the window resets, from `x-ratelimit-reset`; null until seen. */
  resetAtMs: number | null;
  startedMs: number;
  used: Record<BudgetLane, number>;
};

const windows = new Map<string, Window>();

function windowKey(installationId: number, resource: BudgetResource): string {
  return `${installationId}:${resource}`;
}

function freshWindow(limit: number, now: number): Window {
  return {
    limit,
    remaining: null,
    resetAtMs: null,
    startedMs: now,
    used: { interactive: 0, bulk: 0 },
  };
}

function windowEnd(w: Window): number {
  return w.resetAtMs ?? w.startedMs + WINDOW_MS;
}

function getWindow(
  installationId: number,
  resource: BudgetResource,
  now: number,
): Window {
  const key = windowKey(installationId, resource);
  let w = windows.get(key);
  if (!w) {
    if (windows.size >= MAX_WINDOWS) {
      for (const [k, v] of windows) {
        if (windowEnd(v) <= now) windows.delete(k);
      }
      if (windows.size >= MAX_WINDOWS) {
        const first = windows.keys().next().value;
        if (first !== undefined) windows.delete(first);
      }
    }
    w = freshWindow(DEFAULT_LIMIT, now);
    windows.set(key, w);
  } else if (windowEnd(w) <= now) {
    w = freshWindow(w.limit, now);
    windows.set(key, w);
  }
  return w;
}

/** Quota reserved for the bulk lane in a window with this limit. */
export function bulkCap(limit: number): number {
  return Math.floor(limit * BULK_SHARE);
}

function secondsUntil(w: Window, now: number): number {
  return Math.max(1, Math.ceil((windowEnd(w) - now) / 1000));
}

/**
 * Account for one request about to be sent, or refuse it. Counted at dispatch,
 * not on completion, so a burst of concurrent calls cannot all slip under the
 * line before any of them has answered.
 */
export function reserveRequest(args: {
  installationId: number;
  resource: BudgetResource;
  lane: BudgetLane;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  const w = getWindow(args.installationId, args.resource, now);
  const { lane, resource } = args;

  if (w.remaining != null && w.remaining <= 0) {
    throw new GithubBudgetError(
      lane,
      resource,
      secondsUntil(w, now),
      "GitHub reports no requests left",
    );
  }

  if (lane === "bulk") {
    const cap = bulkCap(w.limit);
    if (w.used.bulk >= cap) {
      throw new GithubBudgetError(
        lane,
        resource,
        secondsUntil(w, now),
        `bulk share of ${cap} spent`,
      );
    }
    // Whatever the interactive lane has not yet used of its own share is
    // spoken for, however quiet it has been so far.
    const reserved = Math.max(0, w.limit - cap - w.used.interactive);
    if (w.remaining != null && w.remaining <= reserved) {
      throw new GithubBudgetError(
        lane,
        resource,
        secondsUntil(w, now),
        `${w.remaining} left, ${reserved} held back for interactive work`,
      );
    }
  }

  w.used[lane] += 1;
  if (w.remaining != null) w.remaining -= 1;
}

function header(
  headers: Record<string, unknown> | undefined,
  name: string,
): number | null {
  const raw = headers?.[name];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fold GitHub's own accounting back in. Responses can arrive out of order, so
 * within one window the lower `remaining` wins; a different reset means a new
 * window and replaces everything.
 */
export function observeResponse(args: {
  installationId: number;
  resource: BudgetResource;
  headers: Record<string, unknown> | undefined;
  now?: number;
}): void {
  const { headers } = args;
  if (!headers) return;
  const reported = headers["x-ratelimit-resource"];
  // `integration_manifest`, `code_search` and friends are other quotas.
  if (typeof reported === "string" && reported !== args.resource) return;

  const limit = header(headers, "x-ratelimit-limit");
  const remaining = header(headers, "x-ratelimit-remaining");
  const resetSec = header(headers, "x-ratelimit-reset");
  if (limit == null && remaining == null && resetSec == null) return;

  const now = args.now ?? Date.now();
  const w = getWindow(args.installationId, args.resource, now);
  if (limit != null && limit > 0) w.limit = limit;
  const resetMs = resetSec != null ? resetSec * 1000 : null;
  if (resetMs != null && resetMs !== w.resetAtMs) {
    // A reset we have not seen: either the first response of this window or a
    // new window altogether. Keep our own counts only for the former.
    const newWindow = w.resetAtMs != null && resetMs > w.resetAtMs;
    if (newWindow) {
      w.used = { interactive: 0, bulk: 0 };
      w.startedMs = now;
      w.remaining = null;
    }
    w.resetAtMs = resetMs;
  }
  if (remaining != null) {
    w.remaining =
      w.remaining == null ? remaining : Math.min(w.remaining, remaining);
  }
}

type RequestOptions = { method?: string; url?: string };

/** Which quota a request spends, or null when it is not accounted. */
export function resourceOf(options: RequestOptions): BudgetResource | null {
  const url = options.url ?? "";
  if (url === "/graphql" || url.endsWith("/graphql")) return "graphql";
  // Search has its own per-minute quota, and /rate_limit is free.
  if (url.startsWith("/search") || url.startsWith("/rate_limit")) return null;
  return "core";
}

/**
 * Reads big enough to count as bulk wherever they are made: a three-way diff of
 * two branches (up to 250 commits and 300 files in one answer) and repo-wide PR
 * listings, which page through up to 300 PRs.
 */
export function isLargeRequest(options: RequestOptions): boolean {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const url = options.url ?? "";
  return (
    /^\/repos\/\{owner\}\/\{repo\}\/compare\//.test(url) ||
    url === "/repos/{owner}/{repo}/pulls"
  );
}

/** An explicit lane wins; otherwise a large read is bulk and the rest is not. */
export function resolveLane(options: RequestOptions): BudgetLane {
  return currentLane() ?? (isLargeRequest(options) ? "bulk" : "interactive");
}

/**
 * The `octokit.hook.wrap("request", ...)` wrapper for one installation. REST and
 * GraphQL both go through `octokit.request`, so one hook covers both.
 */
export function budgetWrapper(installationId: number) {
  return async function budgeted<R, O>(
    request: (options: O) => R | Promise<R>,
    options: O,
  ): Promise<R> {
    const opts = options as unknown as RequestOptions;
    const resource = resourceOf(opts);
    if (!resource) return request(options);
    reserveRequest({
      installationId,
      resource,
      lane: resolveLane(opts),
    });
    try {
      const res = await request(options);
      observeResponse({
        installationId,
        resource,
        headers: (res as { headers?: Record<string, unknown> } | null)?.headers,
      });
      return res;
    } catch (e) {
      observeResponse({
        installationId,
        resource,
        headers: (e as { response?: { headers?: Record<string, unknown> } })
          ?.response?.headers,
      });
      throw e;
    }
  };
}

/** Test seam. */
export function resetBudgetForTests(): void {
  windows.clear();
}

/** Counters for an installation, for diagnostics and tests. */
export function budgetSnapshot(
  installationId: number,
  resource: BudgetResource = "core",
): { limit: number; remaining: number | null; used: Record<BudgetLane, number> } {
  const w = windows.get(windowKey(installationId, resource));
  if (!w) return { limit: DEFAULT_LIMIT, remaining: null, used: { interactive: 0, bulk: 0 } };
  return { limit: w.limit, remaining: w.remaining, used: { ...w.used } };
}
