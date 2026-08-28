import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import {
  getVaultConfig,
  getVaultPathFor,
  parseVaultPath,
  vaultEnabled,
} from "./config";
import { VaultClient, VaultError } from "./client";
import { recordResolution, recordCacheHit } from "./status";

type MetricOutcome =
  | "vault_ok"
  | "vault_error"
  | "env_ok"
  | "missing"
  | "cache_hit"
  | "vault_stale_served"
  | "vault_revalidate_error"
  | "vault_value_changed";

function metric(outcome: MetricOutcome, name: string): void {
  Sentry.metrics.count("vault.secret_resolve", 1, {
    attributes: { outcome, "secret.name": name },
  });
}

/**
 * Logical secret names this app can read from Vault. The list bounds what the
 * /admin/vault status page introspects; calling getSecret() with names outside
 * this list still works (env-only or path-based), but they won't show up in
 * the status table. Add new names here when wiring a new consumer.
 */
export const KNOWN_SECRET_NAMES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  // OpenRouter API key for the AI features. Read only inside the AI activity.
  "OPENROUTER_API_KEY",
  // Hexclave (Stack Auth). The publishable client key and project id are public
  // and read directly from process.env; the secret/admin keys and the webhook
  // signing secret may live in Vault, so they're listed here to pre-warm and to
  // surface on the /admin/vault status page.
  "STACK_SECRET_SERVER_KEY",
  "STACK_SUPER_SECRET_ADMIN_KEY",
  "STACK_WEBHOOK_SECRET",
  // Temporal mTLS material. The client certificate, its private key, and the
  // (optional) CA bundle used to verify the Temporal frontend. Resolved once at
  // worker/client startup; PEM strings are passed straight to the SDK's TLS
  // options, never written to disk.
  "TEMPORAL_TLS_CERT",
  "TEMPORAL_TLS_KEY",
  "TEMPORAL_TLS_CA",
] as const;

export type SecretName = (typeof KNOWN_SECRET_NAMES)[number] | string;

export class VaultResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "VaultResolutionError";
  }
}

/**
 * Cache entry keyed by KV path (not by secret name), so the whole KV v2 payload
 * for a path is fetched once and shared across every secret that selects a
 * field from it. For example GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET
 * both live at one path and now cost a single read.
 */
type PathEntry = {
  data: Record<string, string>;
  lastSuccessAt: number; // ms epoch of the last successful, cached read
  expiresAt: number; // lastSuccessAt + hard serve ceiling (VAULT_CACHE_TTL_SECONDS)
  lastRevalidateAt: number; // throttle for background revalidation
  epoch: number; // global epoch snapshot at write time (invalidation race guard)
};

type Breaker = { fails: number; openUntil: number };

const pathCache = new Map<string, PathEntry>();
const pathInflight = new Map<string, Promise<Record<string, string>>>();
const breakers = new Map<string, Breaker>();
const lastWarnAt = new Map<string, number>();
let epoch = 0;
let sharedClient: VaultClient | null = null;

// Throttle the "serving stale" Sentry warning so a sustained outage does not
// flood the issue stream.
const WARN_THROTTLE_MS = 5 * 60 * 1000;

function getClient(): VaultClient {
  if (sharedClient) return sharedClient;
  const cfg = getVaultConfig();
  sharedClient = new VaultClient(cfg, cfg.timeoutMs);
  return sharedClient;
}

/** A value is usable only when it is a non-empty, non-whitespace string. */
function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function sameData(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

// --- circuit breaker (per path) -------------------------------------------

function breakerOpen(fullPath: string, now: number): boolean {
  const b = breakers.get(fullPath);
  return !!b && b.openUntil > now;
}

/** True while a path is in a failing streak (used to flag "serving stale"). */
function breakerFailing(fullPath: string): boolean {
  return (breakers.get(fullPath)?.fails ?? 0) > 0;
}

function recordBreakerFailure(fullPath: string): void {
  const cfg = getVaultConfig();
  const b = breakers.get(fullPath) ?? { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= cfg.breakerThreshold) {
    b.openUntil = Date.now() + cfg.breakerCooldownMs;
  }
  breakers.set(fullPath, b);
}

function recordBreakerSuccess(fullPath: string): void {
  breakers.delete(fullPath);
}

function warnDegraded(
  fullPath: string,
  lastSuccessAt: number,
  err: unknown
): void {
  const now = Date.now();
  if (now - (lastWarnAt.get(fullPath) ?? 0) < WARN_THROTTLE_MS) return;
  lastWarnAt.set(fullPath, now);
  const ageMs = now - lastSuccessAt;
  logger.warn(
    { err, "vault.path": fullPath, "vault.value_age_ms": ageMs },
    "vault revalidation failing; serving last-known-good"
  );
  Sentry.captureMessage("vault: serving stale secret (Vault degraded)", {
    level: "warning",
    tags: { component: "vault" },
    extra: { path: fullPath, valueAgeMs: ageMs },
  });
}

// --- path read (single-flight, shared by blocking + background) ------------

function readPath(fullPath: string): Promise<Record<string, string>> {
  const existing = pathInflight.get(fullPath);
  if (existing) return existing;

  const myEpoch = epoch;
  const promise = getClient()
    .readKvV2(fullPath)
    .then((data) => {
      const now = Date.now();
      // Drop the write if the cache was invalidated mid-flight, so a late read
      // cannot resurrect a value an operator just flushed.
      if (epoch !== myEpoch) return data;
      const cfg = getVaultConfig();
      const prev = pathCache.get(fullPath);
      const changed = !prev || !sameData(prev.data, data);
      pathCache.set(fullPath, {
        data,
        lastSuccessAt: now,
        expiresAt: now + cfg.cacheTtlSeconds * 1000,
        lastRevalidateAt: now,
        epoch: myEpoch,
      });
      recordBreakerSuccess(fullPath);
      // Picking up a rotation: emit a signal so operators can confirm it landed.
      if (changed && prev) metric("vault_value_changed", fullPath);
      return data;
    })
    .catch((e) => {
      recordBreakerFailure(fullPath);
      const entry = pathCache.get(fullPath);
      if (entry) {
        // We still have a usable value, so this is a degraded (stale) state,
        // not an outage. Keep serving, but make the degradation visible.
        entry.lastRevalidateAt = Date.now();
        metric("vault_revalidate_error", fullPath);
        warnDegraded(fullPath, entry.lastSuccessAt, e);
      }
      throw e;
    })
    .finally(() => {
      pathInflight.delete(fullPath);
    });

  pathInflight.set(fullPath, promise);
  return promise;
}

/**
 * Fire a silent background revalidation if one is warranted. Never blocks the
 * caller and never rejects: failures are handled inside readPath (breaker +
 * throttled warning) and the stale value keeps being served.
 */
function maybeRevalidate(fullPath: string): void {
  const now = Date.now();
  if (breakerOpen(fullPath, now)) return;
  if (pathInflight.has(fullPath)) return;
  const entry = pathCache.get(fullPath);
  const intervalMs = getVaultConfig().revalidateIntervalSeconds * 1000;
  if (entry && now - entry.lastRevalidateAt < intervalMs) return;
  void readPath(fullPath).catch(() => {});
}

// --- resolution ------------------------------------------------------------

/**
 * Resolve a secret value. Resolution order:
 *   1. Path cache: serve the last-known-good value immediately and silently
 *      revalidate it in the background (stale-while-revalidate).
 *   2. Vault: a blocking read only on a cold path (or one past the serve
 *      ceiling).
 *   3. process.env[name] fallback (when no Vault path is configured, or as a
 *      last resort while the circuit breaker is open and nothing is cached).
 *
 * A cached value is served for up to VAULT_CACHE_TTL_SECONDS (default 12h)
 * without a successful revalidation. Within that window a transient Vault
 * outage never breaks a caller. Throws VaultResolutionError only on a true cold
 * start (no usable cached value) with Vault failing, or on a structural config
 * error (path has no non-empty field).
 *
 * Concurrent reads of the same KV path share a single in-flight promise, so we
 * never hammer Vault with parallel reads of the same path.
 */
export async function getSecret(name: string): Promise<string | undefined> {
  const path = vaultEnabled() ? getVaultPathFor(name) : null;
  if (path) return resolveViaVault(name, path);
  return resolveViaEnv(name);
}

async function resolveViaVault(
  name: string,
  pathSpec: string
): Promise<string | undefined> {
  const { fullPath, field } = parseVaultPath(pathSpec);
  const now = Date.now();
  const entry = pathCache.get(fullPath);

  // Warm within the serve ceiling: serve now, revalidate silently.
  if (entry && entry.expiresAt > now) {
    const value = entry.data[field];
    if (isNonEmpty(value)) {
      maybeRevalidate(fullPath);
      const stale = breakerFailing(fullPath);
      recordResolution(name, {
        ok: true,
        source: "vault",
        servingStale: stale,
        lastSuccessAt: entry.lastSuccessAt,
      });
      if (stale) {
        metric("vault_stale_served", name);
      } else {
        recordCacheHit(name);
        metric("cache_hit", name);
      }
      return value;
    }
    // Field present in the cached payload but empty/missing: a config error,
    // not something to paper over with stale-serve.
    return failMissingField(name, fullPath, field);
  }

  // Cold, or past the serve ceiling: we must read Vault.
  if (breakerOpen(fullPath, now)) {
    // Breaker is open and we have nothing servable within the ceiling. Skip the
    // (doomed) Vault attempt and fall back to env, else undefined. This bounds
    // latency during a sustained outage instead of blocking on every request.
    return resolveViaEnv(name);
  }

  try {
    const data = await readPath(fullPath);
    const value = data[field];
    if (!isNonEmpty(value)) return failMissingField(name, fullPath, field);
    recordResolution(name, {
      ok: true,
      source: "vault",
      lastSuccessAt: Date.now(),
    });
    metric("vault_ok", name);
    return value;
  } catch (e) {
    if (e instanceof VaultResolutionError) throw e; // missing-field, already recorded
    const msg = e instanceof VaultError ? e.message : String(e);
    logger.error(
      { err: e, "secret.name": name },
      "vault secret resolution failed"
    );
    recordResolution(name, { ok: false, source: "vault", error: msg });
    metric("vault_error", name);
    throw new VaultResolutionError(
      `Failed to resolve ${name} from Vault: ${msg}`,
      e
    );
  }
}

function resolveViaEnv(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length > 0) {
    recordResolution(name, { ok: true, source: "env" });
    metric("env_ok", name);
    return fromEnv;
  }
  recordResolution(name, { ok: false, source: "env", error: "not set" });
  metric("missing", name);
  return undefined;
}

function failMissingField(
  name: string,
  fullPath: string,
  field: string
): never {
  const err = new VaultResolutionError(
    `Vault path ${fullPath} has no non-empty field "${field}"`
  );
  recordResolution(name, { ok: false, source: "vault", error: err.message });
  metric("vault_error", name);
  throw err;
}

/**
 * Pre-resolve every Vault-backed secret so the first real request is warm and
 * the cache holds a last-known-good value before any user or webhook arrives.
 * Never rejects and never blocks boot (call it fire-and-forget). Path coalescing
 * means warming all secrets on one path triggers a single read.
 */
export async function warmupSecrets(): Promise<void> {
  if (!vaultEnabled()) return;
  await Promise.allSettled(
    KNOWN_SECRET_NAMES.filter((n) => getVaultPathFor(n)).map((n) =>
      getSecret(n).catch(() => undefined)
    )
  );
}

export function invalidateSecret(name: string): void {
  epoch += 1;
  const path = getVaultPathFor(name);
  if (!path) return;
  const { fullPath } = parseVaultPath(path);
  pathCache.delete(fullPath);
  breakers.delete(fullPath);
  lastWarnAt.delete(fullPath);
}

export function invalidateAll(): void {
  epoch += 1;
  pathCache.clear();
  pathInflight.clear();
  breakers.clear();
  lastWarnAt.clear();
  sharedClient = null;
}

/** Test-only: inject a stub client and bypass the lazy constructor. */
export function __setVaultClientForTests(client: VaultClient | null): void {
  sharedClient = client;
}

/**
 * Test-only: name-shaped view over the path cache, kept for backward
 * compatibility with tests written against the old name-keyed cache.
 */
export function __getCacheEntryForTests(
  name: string
): { value: string; expiresAt: number } | undefined {
  const path = getVaultPathFor(name);
  if (!path) return undefined;
  const { fullPath, field } = parseVaultPath(path);
  const e = pathCache.get(fullPath);
  if (!e) return undefined;
  const value = e.data[field];
  if (value === undefined) return undefined;
  return { value, expiresAt: e.expiresAt };
}

/** Test-only: introspect the raw path cache entry. */
export function __getPathEntryForTests(fullPath: string): PathEntry | undefined {
  return pathCache.get(fullPath);
}

/** Test-only: introspect circuit breaker state for a path. */
export function __getBreakerForTests(fullPath: string): Breaker | undefined {
  const b = breakers.get(fullPath);
  return b ? { ...b } : undefined;
}
