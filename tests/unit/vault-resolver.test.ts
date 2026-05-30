import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getBreakerForTests,
  __getCacheEntryForTests,
  __getPathEntryForTests,
  __setVaultClientForTests,
  getSecret,
  invalidateAll,
  VaultResolutionError,
  warmupSecrets,
} from "@/lib/vault/resolver";
import { invalidateVaultConfig } from "@/lib/vault/config";
import { VaultClient, VaultNetworkError } from "@/lib/vault/client";
import { __resetStatusesForTests, getSecretStatus } from "@/lib/vault/status";

type StubClient = Pick<VaultClient, "readKvV2">;

function stub(reader: (path: string) => Promise<Record<string, string>>): StubClient {
  return { readKvV2: vi.fn(reader) } as unknown as StubClient;
}

/** Build a stub client around an explicit readKvV2 mock. */
function clientWith(readKvV2: ReturnType<typeof vi.fn>): VaultClient {
  return { readKvV2 } as unknown as VaultClient;
}

/** Standard Vault env so getVaultConfig() succeeds. */
function setVaultEnv(extra: Record<string, string> = {}): void {
  process.env.VAULT_ADDR = "https://vault.example.com";
  process.env.VAULT_AUTH_METHOD = "token";
  process.env.VAULT_TOKEN = "s.test";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

/** Flush microtasks + a macrotask tick so fire-and-forget refreshes settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VAULT_") || k === "GITHUB_APP_PRIVATE_KEY" || k === "SMTP_PASS") {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("VAULT_")) continue;
    process.env[k] = v;
  }
}

describe("getSecret resolver", () => {
  beforeEach(() => {
    resetEnv();
    invalidateAll();
    invalidateVaultConfig();
    __resetStatusesForTests();
  });

  afterEach(() => {
    resetEnv();
    invalidateAll();
    invalidateVaultConfig();
    __setVaultClientForTests(null);
  });

  it("falls back to process.env when no Vault path is set", async () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "from-env";
    const value = await getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(value).toBe("from-env");
  });

  it("returns undefined when neither env nor Vault is configured", async () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const value = await getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(value).toBeUndefined();
  });

  it("resolves from Vault when VAULT_<NAME>_PATH is set", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_GITHUB_APP_PRIVATE_KEY_PATH =
      "secret/data/cc/github#private_key";

    const reader = vi.fn(async () => ({ private_key: "from-vault" }));
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    const value = await getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(value).toBe("from-vault");
    expect(reader).toHaveBeenCalledWith("secret/data/cc/github");
  });

  it("uses default 'value' field when no #field selector is given", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_SMTP_PASS_PATH = "secret/data/cc/smtp";

    const reader = vi.fn(async () => ({ value: "pwd" }));
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    const value = await getSecret("SMTP_PASS");
    expect(value).toBe("pwd");
  });

  it("caches resolved values within the TTL window", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_GITHUB_APP_PRIVATE_KEY_PATH = "secret/data/cc/github";
    process.env.VAULT_CACHE_TTL_SECONDS = "60";

    const reader = vi.fn(async () => ({ value: "v1" }));
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    const a = await getSecret("GITHUB_APP_PRIVATE_KEY");
    const b = await getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(a).toBe("v1");
    expect(b).toBe("v1");
    expect(reader).toHaveBeenCalledTimes(1);

    const entry = __getCacheEntryForTests("GITHUB_APP_PRIVATE_KEY");
    expect(entry?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("coalesces concurrent reads via single-flight", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_GITHUB_APP_PRIVATE_KEY_PATH = "secret/data/cc/github";

    let calls = 0;
    let resolveFn: ((data: Record<string, string>) => void) | null = null;
    const reader = vi.fn(
      () =>
        new Promise<Record<string, string>>((r) => {
          calls += 1;
          resolveFn = r;
        })
    );
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    const p1 = getSecret("GITHUB_APP_PRIVATE_KEY");
    const p2 = getSecret("GITHUB_APP_PRIVATE_KEY");
    const p3 = getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(calls).toBe(1);
    resolveFn!({ value: "shared" });

    expect(await p1).toBe("shared");
    expect(await p2).toBe("shared");
    expect(await p3).toBe("shared");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("throws VaultResolutionError when the configured path errors out", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_GITHUB_APP_PRIVATE_KEY_PATH = "secret/data/cc/github";

    const reader = vi.fn(async () => {
      throw new Error("boom");
    });
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
  });

  it("throws VaultResolutionError when the configured field is missing", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.VAULT_GITHUB_APP_PRIVATE_KEY_PATH =
      "secret/data/cc/github#private_key";

    const reader = vi.fn(async () => ({ other_field: "x" }));
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
  });

  it("does NOT call Vault when only env is set (no Vault path)", async () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "token";
    process.env.VAULT_TOKEN = "s.test";
    process.env.GITHUB_APP_PRIVATE_KEY = "from-env";

    const reader = vi.fn(async () => ({ value: "from-vault" }));
    __setVaultClientForTests(stub(reader) as unknown as VaultClient);

    const value = await getSecret("GITHUB_APP_PRIVATE_KEY");
    expect(value).toBe("from-env");
    expect(reader).not.toHaveBeenCalled();
  });

  it("coalesces two secrets on one KV path into a single read", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_CLIENT_ID_PATH: "secret/data/cc/github#client_id",
      VAULT_GITHUB_APP_CLIENT_SECRET_PATH: "secret/data/cc/github#client_secret",
    });
    const readKvV2 = vi.fn(async () => ({
      client_id: "id",
      client_secret: "sec",
    }));
    __setVaultClientForTests(clientWith(readKvV2));

    const [id, secret] = await Promise.all([
      getSecret("GITHUB_APP_CLIENT_ID"),
      getSecret("GITHUB_APP_CLIENT_SECRET"),
    ]);
    expect(id).toBe("id");
    expect(secret).toBe("sec");
    expect(readKvV2).toHaveBeenCalledTimes(1);
    expect(readKvV2).toHaveBeenCalledWith("secret/data/cc/github");
  });

  it("keeps serving the cached value when revalidation fails (no throw)", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
      VAULT_REVALIDATE_INTERVAL_SECONDS: "0", // revalidate on every access
    });
    const readKvV2 = vi
      .fn()
      .mockResolvedValueOnce({ private_key: "v1" })
      .mockRejectedValue(new VaultNetworkError("vault down"));
    __setVaultClientForTests(clientWith(readKvV2));

    // Cold read seeds the cache.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");

    // Warm read serves v1 and fires a background revalidation that fails.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    await flush();
    expect(__getBreakerForTests("secret/data/cc/github")?.fails).toBeGreaterThan(
      0
    );

    // Still serving the last-known-good value, now flagged stale.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    expect(getSecretStatus("GITHUB_APP_PRIVATE_KEY")?.servingStale).toBe(true);
  });

  it("picks up a rotated value via background revalidation", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
      VAULT_REVALIDATE_INTERVAL_SECONDS: "0",
    });
    const readKvV2 = vi
      .fn()
      .mockResolvedValueOnce({ private_key: "v1" })
      .mockResolvedValue({ private_key: "v2" });
    __setVaultClientForTests(clientWith(readKvV2));

    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    // Warm read returns v1 immediately and revalidates in the background.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    await flush();
    // Next read serves the refreshed value.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v2");
  });

  it("fails closed past the serve ceiling when Vault is down", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
    });
    const readKvV2 = vi
      .fn()
      .mockResolvedValueOnce({ private_key: "v1" })
      .mockRejectedValue(new VaultNetworkError("vault down"));
    __setVaultClientForTests(clientWith(readKvV2));

    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    // Age the cached entry past its serve ceiling.
    const entry = __getPathEntryForTests("secret/data/cc/github");
    entry!.expiresAt = Date.now() - 1000;

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
  });

  it("treats an empty field as missing (never serves it)", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
    });
    const readKvV2 = vi.fn(async () => ({ private_key: "   " }));
    __setVaultClientForTests(clientWith(readKvV2));

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
  });

  it("opens the breaker after repeated failures and stops hitting Vault", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
      VAULT_BREAKER_THRESHOLD: "2",
    });
    delete process.env.GITHUB_APP_PRIVATE_KEY; // no env fallback
    const readKvV2 = vi.fn().mockRejectedValue(new VaultNetworkError("down"));
    __setVaultClientForTests(clientWith(readKvV2));

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
    // Breaker is now open: the next call skips Vault and falls back to env
    // (here undefined) instead of blocking on a doomed read.
    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBeUndefined();
    expect(readKvV2).toHaveBeenCalledTimes(2);
  });

  it("resets the breaker after a successful read", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
    });
    const readKvV2 = vi
      .fn()
      .mockRejectedValueOnce(new VaultNetworkError("blip"))
      .mockResolvedValue({ private_key: "v1" });
    __setVaultClientForTests(clientWith(readKvV2));

    await expect(getSecret("GITHUB_APP_PRIVATE_KEY")).rejects.toBeInstanceOf(
      VaultResolutionError
    );
    expect(__getBreakerForTests("secret/data/cc/github")?.fails).toBe(1);

    expect(await getSecret("GITHUB_APP_PRIVATE_KEY")).toBe("v1");
    expect(__getBreakerForTests("secret/data/cc/github")).toBeUndefined();
  });

  it("does not resurrect the cache when invalidated mid-read (epoch guard)", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_PRIVATE_KEY_PATH: "secret/data/cc/github#private_key",
    });
    let resolveRead!: (d: Record<string, string>) => void;
    const readKvV2 = vi.fn(
      () =>
        new Promise<Record<string, string>>((res) => {
          resolveRead = res;
        })
    );
    __setVaultClientForTests(clientWith(readKvV2));

    const p = getSecret("GITHUB_APP_PRIVATE_KEY"); // cold read in flight
    invalidateAll(); // bumps epoch + clears cache
    // Re-install the stub: invalidateAll() drops the shared client.
    __setVaultClientForTests(clientWith(readKvV2));
    resolveRead({ private_key: "v1" });

    expect(await p).toBe("v1");
    expect(__getPathEntryForTests("secret/data/cc/github")).toBeUndefined();
  });

  it("warmupSecrets pre-populates the cache with one read per path", async () => {
    setVaultEnv({
      VAULT_GITHUB_APP_CLIENT_ID_PATH: "secret/data/cc/github#client_id",
      VAULT_GITHUB_APP_CLIENT_SECRET_PATH: "secret/data/cc/github#client_secret",
    });
    const readKvV2 = vi.fn(async () => ({
      client_id: "id",
      client_secret: "sec",
    }));
    __setVaultClientForTests(clientWith(readKvV2));

    await warmupSecrets();
    expect(readKvV2).toHaveBeenCalledTimes(1);

    // Subsequent resolution is a warm cache hit (no extra read within the
    // default revalidate throttle).
    expect(await getSecret("GITHUB_APP_CLIENT_ID")).toBe("id");
    expect(readKvV2).toHaveBeenCalledTimes(1);
  });
});
