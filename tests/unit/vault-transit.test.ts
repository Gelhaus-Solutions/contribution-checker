import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultAuthError, VaultClient } from "@/lib/vault/client";
import type { VaultConfig } from "@/lib/vault/config";

function makeConfig(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    addr: "https://vault.example.com",
    auth: { method: "token", token: "s.test" },
    cacheTtlSeconds: 300,
    revalidateIntervalSeconds: 0,
    timeoutMs: 5000,
    maxRetries: 0,
    breakerThreshold: 5,
    breakerCooldownMs: 30000,
    transitMount: "transit",
    transitKey: "contribution-checker",
    ...over,
  };
}

const noSleep = async (): Promise<void> => {};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("VaultClient transit", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = (over: Partial<VaultConfig> = {}) =>
    new VaultClient(
      makeConfig(over),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep,
    );

  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("encrypts to transit/encrypt/<key> with base64 plaintext and returns the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: { ciphertext: "vault:v1:abcd" } }),
    );
    const ct = await client().transitEncrypt("s3cret");
    expect(ct).toBe("vault:v1:abcd");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://vault.example.com/v1/transit/encrypt/contribution-checker");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      plaintext: b64("s3cret"),
      context: b64("contribution-checker/credentials"),
    });
    expect(((init as RequestInit).headers as Headers).get("x-vault-token")).toBe("s.test");
  });

  it("honours a custom mount and key name", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { ciphertext: "vault:v2:x" } }));
    await client({ transitMount: "kms/transit", transitKey: "cc prod" }).transitEncrypt("x");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://vault.example.com/v1/kms/transit/encrypt/cc%20prod",
    );
  });

  it("decrypts a batch in one request and keeps the order", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: { batch_results: [{ plaintext: b64("one") }, { plaintext: b64("two") }] },
      }),
    );
    const out = await client().transitDecryptBatch(["vault:v1:a", "vault:v1:b"]);
    expect(out).toEqual(["one", "two"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://vault.example.com/v1/transit/decrypt/contribution-checker",
    );
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      batch_input: [
        { ciphertext: "vault:v1:a", context: b64("contribution-checker/credentials") },
        { ciphertext: "vault:v1:b", context: b64("contribution-checker/credentials") },
      ],
    });
  });

  it("fails a batch when one item errors, without echoing Vault's detail", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: {
          batch_results: [{ plaintext: b64("ok") }, { error: "key transit/keys/secret-name is bad" }],
        },
      }),
    );
    await expect(client().transitDecryptBatch(["vault:v1:a", "vault:v1:b"])).rejects.toThrow(
      /failed for one value/,
    );
  });

  it("does not call Vault for an empty batch", async () => {
    expect(await client().transitDecryptBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a missing policy as an auth error and does not retry it", async () => {
    fetchMock.mockResolvedValue(json({ errors: ["permission denied"] }, 403));
    await expect(client({ maxRetries: 2 }).transitEncrypt("x")).rejects.toBeInstanceOf(
      VaultAuthError,
    );
  });

  it("retries a transient 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ errors: ["busy"] }, 503))
      .mockResolvedValueOnce(json({ data: { ciphertext: "vault:v1:ok" } }));
    expect(await client({ maxRetries: 2 }).transitEncrypt("x")).toBe("vault:v1:ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---- the credential helpers --------------------------------------------------

const encrypt = vi.fn();
const decryptBatch = vi.fn();
vi.mock("@/lib/vault/resolver", () => ({
  getVaultClient: () => ({
    transitEncrypt: (...a: unknown[]) => encrypt(...a),
    transitDecryptBatch: (...a: unknown[]) => decryptBatch(...a),
  }),
}));

import {
  CredentialCryptoError,
  decryptCredential,
  decryptCredentials,
  encryptCredential,
  isTransitCiphertext,
} from "@/lib/vault/transit";

describe("credential encryption", () => {
  beforeEach(() => {
    encrypt.mockReset();
    decryptBatch.mockReset();
    vi.stubEnv("VAULT_ADDR", "https://vault.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("recognises Vault's envelope on any key version", () => {
    expect(isTransitCiphertext("vault:v1:abc")).toBe(true);
    expect(isTransitCiphertext("vault:v12:abc")).toBe(true);
    expect(isTransitCiphertext("secret_abc")).toBe(false);
    expect(isTransitCiphertext("vault:kv")).toBe(false);
  });

  it("encrypts on write and stores the envelope", async () => {
    encrypt.mockResolvedValue("vault:v1:CIPHER");
    expect(await encryptCredential("ntn_plain")).toBe("vault:v1:CIPHER");
    expect(encrypt).toHaveBeenCalledWith("ntn_plain");
  });

  it("encrypts what a person typed even when it looks like an envelope", async () => {
    encrypt.mockResolvedValue("vault:v1:CIPHER");
    await encryptCredential("vault:v1:typed-by-a-person");
    expect(encrypt).toHaveBeenCalledWith("vault:v1:typed-by-a-person");
  });

  it("leaves null and empty alone (a cleared secret is not encrypted)", async () => {
    expect(await encryptCredential(null)).toBeNull();
    expect(await encryptCredential(undefined)).toBeNull();
    expect(await encryptCredential("")).toBe("");
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("fails closed: no plaintext fallback when Vault errors", async () => {
    encrypt.mockRejectedValue(new Error("vault down: token s.abc"));
    const err = await encryptCredential("topsecret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialCryptoError);
    expect((err as Error).message).not.toContain("topsecret");
    expect((err as Error).message).not.toContain("s.abc");
  });

  it("stores plaintext as before when Vault is not configured", async () => {
    vi.stubEnv("VAULT_ADDR", "");
    expect(await encryptCredential("plain")).toBe("plain");
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("decrypts an envelope on read", async () => {
    decryptBatch.mockResolvedValue(["ntn_plain"]);
    expect(await decryptCredential("vault:v1:CIPHER")).toBe("ntn_plain");
    expect(decryptBatch).toHaveBeenCalledWith(["vault:v1:CIPHER"]);
  });

  it("returns a legacy plaintext row as is, without calling Vault", async () => {
    expect(await decryptCredential("ntn_legacy")).toBe("ntn_legacy");
    expect(decryptBatch).not.toHaveBeenCalled();
  });

  it("decrypts only the encrypted entries of a mixed batch, in one call", async () => {
    decryptBatch.mockResolvedValue(["P1", "P3"]);
    const out = await decryptCredentials(["vault:v1:a", "legacy", null, "vault:v2:b", undefined]);
    expect(out).toEqual(["P1", "legacy", null, "P3", null]);
    expect(decryptBatch).toHaveBeenCalledTimes(1);
    expect(decryptBatch).toHaveBeenCalledWith(["vault:v1:a", "vault:v2:b"]);
  });

  it("raises when an envelope is stored but Vault is not configured", async () => {
    vi.stubEnv("VAULT_ADDR", "");
    await expect(decryptCredential("vault:v1:CIPHER")).rejects.toBeInstanceOf(
      CredentialCryptoError,
    );
  });

  it("raises, rather than returning garbage, when decrypt fails", async () => {
    decryptBatch.mockRejectedValue(new Error("boom"));
    await expect(decryptCredential("vault:v1:CIPHER")).rejects.toBeInstanceOf(
      CredentialCryptoError,
    );
  });
});
