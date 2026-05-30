import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VaultAuthError,
  VaultClient,
  VaultNetworkError,
  VaultNotFoundError,
} from "@/lib/vault/client";
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
    ...over,
  };
}

// Instant sleep so retry/backoff tests don't wait on real timers.
const noSleep = async (): Promise<void> => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VaultClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads KV v2 with the token method (no extra login call)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { data: { value: "hello" } } })
    );
    const client = new VaultClient(
      makeConfig(),
      5000,
      fetchMock as unknown as typeof fetch
    );
    const data = await client.readKvV2("secret/data/foo");
    expect(data.value).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://vault.example.com/v1/secret/data/foo");
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((init as RequestInit).headers as Headers).get("x-vault-token")).toBe(
      "s.test"
    );
  });

  it("performs AppRole login then attaches the returned token", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          auth: { client_token: "s.derived", lease_duration: 3600 },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));

    const client = new VaultClient(
      makeConfig({
        auth: {
          method: "approle",
          roleId: "rid",
          secretId: "sid",
          mountPath: "approle",
        },
      }),
      5000,
      fetchMock as unknown as typeof fetch
    );

    const data = await client.readKvV2("secret/data/foo");
    expect(data.value).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const loginUrl = fetchMock.mock.calls[0]![0];
    expect(loginUrl).toBe("https://vault.example.com/v1/auth/approle/login");
    const readHeaders = (fetchMock.mock.calls[1]![1] as RequestInit)
      .headers as Headers;
    expect(readHeaders.get("x-vault-token")).toBe("s.derived");
  });

  it("throws VaultAuthError when AppRole returns no client_token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ auth: {} }));
    const client = new VaultClient(
      makeConfig({
        auth: {
          method: "approle",
          roleId: "rid",
          secretId: "sid",
          mountPath: "approle",
        },
      }),
      5000,
      fetchMock as unknown as typeof fetch
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultAuthError
    );
  });

  it("re-logs in once after a 403 on a cached token", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          auth: { client_token: "s.first", lease_duration: 3600 },
        })
      )
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          auth: { client_token: "s.second", lease_duration: 3600 },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));

    const client = new VaultClient(
      makeConfig({
        auth: {
          method: "approle",
          roleId: "rid",
          secretId: "sid",
          mountPath: "approle",
        },
      }),
      5000,
      fetchMock as unknown as typeof fetch
    );
    const data = await client.readKvV2("secret/data/foo");
    expect(data.value).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws VaultAuthError on persistent 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const client = new VaultClient(
      makeConfig(),
      5000,
      fetchMock as unknown as typeof fetch
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultAuthError
    );
  });

  it("throws VaultNotFoundError on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    const client = new VaultClient(
      makeConfig(),
      5000,
      fetchMock as unknown as typeof fetch
    );
    await expect(client.readKvV2("secret/data/missing")).rejects.toBeInstanceOf(
      VaultNotFoundError
    );
  });

  it("sends x-vault-namespace header when configured", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { data: { value: "hi" } } })
    );
    const client = new VaultClient(
      makeConfig({ namespace: "team-a" }),
      5000,
      fetchMock as unknown as typeof fetch
    );
    await client.readKvV2("secret/data/foo");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit)
      .headers as Headers;
    expect(headers.get("x-vault-namespace")).toBe("team-a");
  });

  it("retries a transient network error then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));
    const client = new VaultClient(
      makeConfig({ maxRetries: 2 }),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep
    );
    const data = await client.readKvV2("secret/data/foo");
    expect(data.value).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));
    const client = new VaultClient(
      makeConfig({ maxRetries: 2 }),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep
    );
    const data = await client.readKvV2("secret/data/foo");
    expect(data.value).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    const client = new VaultClient(
      makeConfig({ maxRetries: 3 }),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultNotFoundError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const client = new VaultClient(
      makeConfig({ maxRetries: 3 }),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultAuthError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries then throws the last transient error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const client = new VaultClient(
      makeConfig({ maxRetries: 2 }),
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultNetworkError
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps timeouts as VaultNetworkError", async () => {
    fetchMock.mockImplementation(
      (_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const client = new VaultClient(
      makeConfig(),
      10,
      fetchMock as unknown as typeof fetch
    );
    await expect(client.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(
      VaultNetworkError
    );
  });
});
