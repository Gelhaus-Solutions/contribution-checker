import { z } from "zod";

/**
 * Vault env config. Kept separate from src/lib/env.ts because:
 *   - It must be readable lazily, after src/lib/env.ts has already been
 *     evaluated. The auth credentials (token, role/secret id) are deliberately
 *     NOT in the typed `env` object so they're never accidentally serialized
 *     into logs or status payloads.
 *   - A misconfigured Vault setup throws here, not in the global env loader.
 */

const baseSchema = z.object({
  VAULT_ADDR: z.string().url(),
  VAULT_NAMESPACE: z.string().optional(),
  VAULT_AUTH_METHOD: z.enum(["token", "approle"]).default("token"),
  VAULT_TOKEN: z.string().optional(),
  VAULT_APPROLE_ROLE_ID: z.string().optional(),
  VAULT_APPROLE_SECRET_ID: z.string().optional(),
  VAULT_APPROLE_MOUNT: z.string().default("approle"),
  // Hard serve ceiling: how long a cached value may be served WITHOUT a
  // successful background revalidation. The resolver revalidates silently on
  // every access (subject to the throttle below), so this only bites during a
  // sustained Vault outage. Default is 12h.
  VAULT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  // Minimum gap between background revalidations of the same path. 0 means
  // revalidate on every access (concurrent reads still coalesce to one).
  VAULT_REVALIDATE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(15),
  // Per-attempt request timeout. Plumbed into the VaultClient.
  VAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Retries for transient errors only (network/timeout, 5xx). 0 disables.
  VAULT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  // Circuit breaker: open after this many consecutive transient failures for a
  // path, then skip Vault for the cooldown window and serve last-known-good.
  VAULT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  VAULT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
});

export type VaultAuthConfig =
  | { method: "token"; token: string }
  | {
      method: "approle";
      roleId: string;
      secretId: string;
      mountPath: string;
    };

export type VaultConfig = {
  addr: string;
  namespace?: string;
  auth: VaultAuthConfig;
  cacheTtlSeconds: number;
  revalidateIntervalSeconds: number;
  timeoutMs: number;
  maxRetries: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
};

let cached: VaultConfig | null = null;

export function vaultEnabled(): boolean {
  return !!process.env.VAULT_ADDR;
}

/**
 * Parse + validate Vault config from process.env. Throws when VAULT_ADDR is
 * set but the auth fields are incomplete. Result is cached for the process
 * lifetime; call invalidateVaultConfig() in tests to reset.
 */
export function getVaultConfig(): VaultConfig {
  if (cached) return cached;
  if (!vaultEnabled()) {
    throw new Error("Vault is not configured (VAULT_ADDR is unset).");
  }
  const parsed = baseSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Vault env:\n${issues}`);
  }
  const raw = parsed.data;

  let auth: VaultAuthConfig;
  if (raw.VAULT_AUTH_METHOD === "token") {
    if (!raw.VAULT_TOKEN) {
      throw new Error(
        "VAULT_AUTH_METHOD=token requires VAULT_TOKEN to be set."
      );
    }
    auth = { method: "token", token: raw.VAULT_TOKEN };
  } else {
    if (!raw.VAULT_APPROLE_ROLE_ID || !raw.VAULT_APPROLE_SECRET_ID) {
      throw new Error(
        "VAULT_AUTH_METHOD=approle requires VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID."
      );
    }
    auth = {
      method: "approle",
      roleId: raw.VAULT_APPROLE_ROLE_ID,
      secretId: raw.VAULT_APPROLE_SECRET_ID,
      mountPath: raw.VAULT_APPROLE_MOUNT,
    };
  }

  cached = {
    addr: raw.VAULT_ADDR.replace(/\/$/, ""),
    namespace: raw.VAULT_NAMESPACE,
    auth,
    cacheTtlSeconds: raw.VAULT_CACHE_TTL_SECONDS,
    revalidateIntervalSeconds: raw.VAULT_REVALIDATE_INTERVAL_SECONDS,
    timeoutMs: raw.VAULT_TIMEOUT_MS,
    maxRetries: raw.VAULT_MAX_RETRIES,
    breakerThreshold: raw.VAULT_BREAKER_THRESHOLD,
    breakerCooldownMs: raw.VAULT_BREAKER_COOLDOWN_MS,
  };
  return cached;
}

export function invalidateVaultConfig(): void {
  cached = null;
}

/**
 * For a logical secret name (e.g. "GITHUB_APP_PRIVATE_KEY"), returns the
 * configured Vault path, or null if no path is set. Path may include a
 * "#field" suffix to select one key from the KV v2 payload.
 */
export function getVaultPathFor(name: string): string | null {
  const v = process.env[`VAULT_${name}_PATH`];
  return v && v.length > 0 ? v : null;
}

/**
 * Parse "secret/data/path#field" → { mount, path, field? }. The mount is the
 * first path segment; the rest forms the secret path. KV v2 reads use the
 * full path as-is so operators can include "/data/" themselves.
 */
export function parseVaultPath(spec: string): {
  fullPath: string;
  field: string;
} {
  const hashAt = spec.indexOf("#");
  if (hashAt === -1) {
    return { fullPath: spec.replace(/^\//, ""), field: "value" };
  }
  return {
    fullPath: spec.slice(0, hashAt).replace(/^\//, ""),
    field: spec.slice(hashAt + 1) || "value",
  };
}
