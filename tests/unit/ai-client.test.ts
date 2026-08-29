import { beforeEach, describe, expect, it, vi } from "vitest";

const getSecret = vi.fn();
vi.mock("@/lib/vault/resolver", () => ({ getSecret: (n: string) => getSecret(n) }));

import { callModel } from "@/lib/ai/client";
import { costMicrosFor } from "@/lib/ai/models";

const okBody = (over: Record<string, unknown> = {}) => ({
  model: "google/gemini-2.5-flash-lite",
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 800 },
  },
  ...over,
});

const args = {
  model: "google/gemini-2.5-flash-lite",
  system: "sys",
  user: "usr",
  jsonSchema: { type: "object" },
  schemaName: "t",
};

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, ...res }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  getSecret.mockReset().mockResolvedValue("sk-or-test");
});

describe("callModel", () => {
  it("returns content and usage on success", async () => {
    mockFetch({ json: async () => okBody() });
    const r = await callModel(args);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('{"ok":true}');
    expect(r.usage.promptTokens).toBe(1000);
    expect(r.usage.cachedTokens).toBe(800);
    // 200 fresh @ $0.10/M + 800 cached @ $0.01/M + 100 out @ $0.40/M
    expect(r.usage.costMicros).toBe(
      costMicrosFor({
        model: args.model,
        promptTokens: 1000,
        completionTokens: 100,
        cachedTokens: 800,
      })
    );
  });

  it("never sends the api key as an argument, only a header", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody() });
    vi.stubGlobal("fetch", spy);
    await callModel(args);
    const [, init] = spy.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    expect(JSON.stringify(init.body)).not.toContain("sk-or-test");
  });

  it("is terminal with no key configured, and does not call fetch", async () => {
    getSecret.mockResolvedValue(undefined);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await callModel(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("terminal");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [402, "terminal"],
    [401, "terminal"],
    [403, "terminal"],
    [400, "terminal"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ])("classifies HTTP %i as %s", async (status, kind) => {
    mockFetch({ ok: false, status, text: async () => "boom" });
    const r = await callModel(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe(kind);
    expect(r.status).toBe(status);
  });

  it("treats a timeout as transient rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
    );
    const r = await callModel(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("transient");
  });

  it("does not lose the answer when the usage block is missing", async () => {
    mockFetch({ json: async () => okBody({ usage: undefined }) });
    const r = await callModel(args);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('{"ok":true}');
    expect(r.usage.costMicros).toBe(0);
  });

  it("reports an empty choices array as a failure, not a crash", async () => {
    mockFetch({ json: async () => okBody({ choices: [] }) });
    const r = await callModel(args);
    expect(r.ok).toBe(false);
  });

  it("records the model the provider actually used", async () => {
    mockFetch({ json: async () => okBody({ model: "google/gemini-3.7-flash" }) });
    const r = await callModel(args);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe("google/gemini-3.7-flash");
  });
});

describe("provider pin", () => {
  it("sends no provider hint by default, so BYOK routing is preferred", async () => {
    // Unset is the cheap default: OpenRouter prefers a BYOK route, which bills
    // nothing while a free tier lasts.
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody() });
    vi.stubGlobal("fetch", spy);
    await callModel(args);
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.provider).toBeUndefined();
  });

  it("refuses to fall through to an unvalidated provider when pinned", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", async () => {
      const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
      return { env: { ...actual.env, AI_PROVIDER_ORDER: "Groq, AkashML" } };
    });
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody() });
    vi.stubGlobal("fetch", spy);
    const { callModel: pinned } = await import("@/lib/ai/client");
    await pinned(args);
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.provider.order).toEqual(["Groq", "AkashML"]);
    // The pin exists to bound traffic to weights validated against the
    // injection case; falling through would defeat the entire point.
    expect(body.provider.allow_fallbacks).toBe(false);
    vi.doUnmock("@/lib/env");
    vi.resetModules();
  });
});

describe("costMicrosFor", () => {
  it("bills cached prompt tokens at the cache rate", () => {
    const allFresh = costMicrosFor({
      model: "google/gemini-2.5-flash-lite",
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 0,
    });
    const allCached = costMicrosFor({
      model: "google/gemini-2.5-flash-lite",
      promptTokens: 1000,
      completionTokens: 0,
      cachedTokens: 1000,
    });
    expect(allCached).toBeLessThan(allFresh);
    expect(allFresh).toBe(100); // 1000 * $0.10/M = $0.0001 = 100 micros
    expect(allCached).toBe(10); // 1000 * $0.01/M
  });

  it("records zero rather than guessing for an unpriced model", () => {
    expect(
      costMicrosFor({
        model: "some/unknown-model",
        promptTokens: 5000,
        completionTokens: 500,
        cachedTokens: 0,
      })
    ).toBe(0);
  });
});
