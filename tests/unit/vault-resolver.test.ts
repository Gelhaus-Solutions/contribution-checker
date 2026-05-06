import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getCacheEntryForTests,
  __setVaultClientForTests,
  getSecret,
  invalidateAll,
  VaultResolutionError,
} from "@/lib/vault/resolver";
import { invalidateVaultConfig } from "@/lib/vault/config";
import { VaultClient } from "@/lib/vault/client";
import { __resetStatusesForTests } from "@/lib/vault/status";

type StubClient = Pick<VaultClient, "readKvV2">;

function stub(reader: (path: string) => Promise<Record<string, string>>): StubClient {
  return { readKvV2: vi.fn(reader) } as unknown as StubClient;
}

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
});
