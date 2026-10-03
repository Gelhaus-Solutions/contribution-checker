import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plan = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { gptermsConfigured: true, GPTERMS_URL: "https://terms.example", GPTERMS_API_KEY: "gpt_prod_x" } }));
vi.mock("@/lib/vault/resolver", () => ({ getSecret: vi.fn() }));
vi.mock("@/lib/account-erasure", () => ({ PRIVACY_CATALOGUE: [{ id: "account" }], runPrivacyPlan: plan.run }));

import { processPrivacyRuns } from "@/lib/privacy-runs";

const run = (id: string, execute: boolean) => ({
  id,
  reference: "DSR-2026-10-03-1",
  kind: "erasure",
  subject: { email: null, identifiers: { github: "someone" }, accountIds: [] },
  plan: { account: "pseudonymise" },
  execute,
});

describe("processPrivacyRuns", () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method: string; body?: string }) => {
        calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
        const body = url.endsWith("/take") ? { runs: [run("r1", false), run("r2", true)] } : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("publishes the catalogue, takes the runs, and reports each one, a failure included", async () => {
    plan.run.mockResolvedValueOnce({ found: {}, done: {}, kept: [], notes: [] });
    plan.run.mockRejectedValueOnce(new Error("PRIVACY_PSEUDONYM_KEY is not available"));
    const result = await processPrivacyRuns(10 * 60 * 60 * 1000);
    expect(result).toEqual({ taken: 2, done: 1, failed: 1 });
    expect(calls.map((one) => `${one.method} ${one.url.replace("https://terms.example/api/v1", "")}`)).toEqual([
      "PUT /erasure-catalogues/contribution-checker",
      "POST /privacy-runs/contribution-checker/take",
      "POST /privacy-runs/contribution-checker/r1/report",
      "POST /privacy-runs/contribution-checker/r2/report",
    ]);
    expect(calls[3]?.body).toEqual({ ok: false, error: "PRIVACY_PSEUDONYM_KEY is not available" });
    expect(plan.run.mock.calls[1]?.[2]).toEqual({ execute: true, requestRef: "DSR-2026-10-03-1" });
  });

  it("publishes the catalogue at most hourly", async () => {
    await processPrivacyRuns(10 * 60 * 60 * 1000 + 60_000);
    expect(calls.some((one) => one.method === "PUT")).toBe(false);
  });
});
