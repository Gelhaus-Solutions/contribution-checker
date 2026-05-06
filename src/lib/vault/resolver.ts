import { logger } from "@/lib/logger";
import {
  getVaultConfig,
  getVaultPathFor,
  parseVaultPath,
  vaultEnabled,
} from "./config";
import { VaultClient, VaultError } from "./client";
import { recordResolution, recordCacheHit } from "./status";

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
] as const;

export type SecretName = (typeof KNOWN_SECRET_NAMES)[number] | string;

export class VaultResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "VaultResolutionError";
  }
}

type CacheEntry = { value: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | undefined>>();
let sharedClient: VaultClient | null = null;

function getClient(): VaultClient {
  if (sharedClient) return sharedClient;
  sharedClient = new VaultClient(getVaultConfig());
  return sharedClient;
}

/**
 * Resolve a secret value. Resolution order:
 *   1. In-memory cache (TTL = VAULT_CACHE_TTL_SECONDS).
 *   2. Vault — only if VAULT_<NAME>_PATH is set AND VAULT_ADDR is set.
 *   3. process.env[name] fallback.
 *
 * Throws VaultResolutionError when a Vault path is configured but the read
 * fails (fail-closed). Returns undefined when neither Vault nor env yields
 * a value (callers decide whether that's an error in their context).
 *
 * Concurrent calls for the same name share a single in-flight promise so we
 * never hammer Vault with parallel reads of the same secret.
 */
export async function getSecret(name: string): Promise<string | undefined> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    recordCacheHit(name);
    return cached.value;
  }

  const existing = inflight.get(name);
  if (existing) return existing;

  const promise = resolveOnce(name).finally(() => {
    inflight.delete(name);
  });
  inflight.set(name, promise);
  return promise;
}

async function resolveOnce(name: string): Promise<string | undefined> {
  const path = getVaultPathFor(name);
  if (path && vaultEnabled()) {
    try {
      const client = getClient();
      const { fullPath, field } = parseVaultPath(path);
      const data = await client.readKvV2(fullPath);
      const value = data[field];
      if (value === undefined) {
        const err = new VaultResolutionError(
          `Vault path ${fullPath} has no field "${field}"`
        );
        recordResolution(name, { ok: false, source: "vault", error: err.message });
        throw err;
      }
      const ttlMs = getVaultConfig().cacheTtlSeconds * 1000;
      cache.set(name, { value, expiresAt: Date.now() + ttlMs });
      recordResolution(name, { ok: true, source: "vault" });
      return value;
    } catch (e) {
      // Re-throw VaultResolutionError as-is; wrap others so callers see a
      // consistent error type.
      if (e instanceof VaultResolutionError) throw e;
      const msg = e instanceof VaultError ? e.message : String(e);
      logger.error({ err: e, name }, "vault secret resolution failed");
      recordResolution(name, { ok: false, source: "vault", error: msg });
      throw new VaultResolutionError(
        `Failed to resolve ${name} from Vault: ${msg}`,
        e
      );
    }
  }

  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length > 0) {
    recordResolution(name, { ok: true, source: "env" });
    return fromEnv;
  }
  recordResolution(name, { ok: false, source: "env", error: "not set" });
  return undefined;
}

export function invalidateSecret(name: string): void {
  cache.delete(name);
}

export function invalidateAll(): void {
  cache.clear();
  sharedClient = null;
}

/** Test-only: inject a stub client and bypass the lazy constructor. */
export function __setVaultClientForTests(client: VaultClient | null): void {
  sharedClient = client;
}

/** Test-only: introspect cache state. */
export function __getCacheEntryForTests(name: string): CacheEntry | undefined {
  return cache.get(name);
}
