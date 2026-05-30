/**
 * In-memory introspection state for the /admin/vault status page. The
 * resolver records each resolution outcome here; the page reads a snapshot.
 * No secret values are stored: only metadata (which name, where it came
 * from, last error message).
 */

export type ResolutionSource = "vault" | "env";

export type SecretStatus = {
  name: string;
  lastResolvedAt: Date | null;
  lastSource: ResolutionSource | null;
  lastOk: boolean | null;
  lastError: string | null;
  cacheHits: number;
  // True when the value currently being served is stale because background
  // revalidation is failing (Vault degraded but we still have a usable value).
  servingStale: boolean;
  // When Vault last returned this value successfully. Survives later failures
  // so the status page can show "last good Nh ago" while degraded.
  lastSuccessAt: Date | null;
};

const statuses = new Map<string, SecretStatus>();

function ensure(name: string): SecretStatus {
  let s = statuses.get(name);
  if (!s) {
    s = {
      name,
      lastResolvedAt: null,
      lastSource: null,
      lastOk: null,
      lastError: null,
      cacheHits: 0,
      servingStale: false,
      lastSuccessAt: null,
    };
    statuses.set(name, s);
  }
  return s;
}

export function recordResolution(
  name: string,
  result: {
    ok: boolean;
    source: ResolutionSource;
    error?: string;
    servingStale?: boolean;
    lastSuccessAt?: number;
  }
): void {
  const s = ensure(name);
  s.lastResolvedAt = new Date();
  s.lastSource = result.source;
  s.lastOk = result.ok;
  s.lastError = result.error ?? null;
  s.servingStale = result.servingStale ?? false;
  // Only advance lastSuccessAt on a genuine success; leave it intact on
  // failures so the page can show how old the served value is.
  if (result.ok && result.lastSuccessAt !== undefined) {
    s.lastSuccessAt = new Date(result.lastSuccessAt);
  }
}

export function recordCacheHit(name: string): void {
  ensure(name).cacheHits += 1;
}

export function getSecretStatuses(): SecretStatus[] {
  return Array.from(statuses.values()).map((s) => ({ ...s }));
}

export function getSecretStatus(name: string): SecretStatus | null {
  const s = statuses.get(name);
  return s ? { ...s } : null;
}

/** Test-only. */
export function __resetStatusesForTests(): void {
  statuses.clear();
}
