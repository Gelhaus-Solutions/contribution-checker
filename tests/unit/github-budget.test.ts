import { beforeEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import {
  GithubBudgetError,
  budgetSnapshot,
  budgetWrapper,
  bulkCap,
  inBulkLane,
  isLargeRequest,
  observeResponse,
  reserveRequest,
  resetBudgetForTests,
  resolveLane,
  resourceOf,
} from "@/lib/github/budget";
import { classifyGithubError, rateLimitDelayMs } from "@/lib/github/errors";

const INST = 1;

function seed(limit: number, remaining: number, resetSec: number) {
  observeResponse({
    installationId: INST,
    resource: "core",
    headers: {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(resetSec),
      "x-ratelimit-resource": "core",
    },
  });
}

describe("github request budget", () => {
  beforeEach(() => resetBudgetForTests());

  it("gives the bulk lane 25% of the limit", () => {
    expect(bulkCap(6850)).toBe(1712);
    expect(bulkCap(5000)).toBe(1250);
  });

  it("stops bulk at its cap and leaves interactive untouched", () => {
    const now = Date.now();
    seed(100, 100, Math.floor(now / 1000) + 3600);
    for (let i = 0; i < 25; i++) {
      reserveRequest({ installationId: INST, resource: "core", lane: "bulk" });
    }
    expect(() =>
      reserveRequest({ installationId: INST, resource: "core", lane: "bulk" }),
    ).toThrow(GithubBudgetError);
    // 25 spent, so 75 remain: all of it is the interactive share.
    for (let i = 0; i < 75; i++) {
      reserveRequest({
        installationId: INST,
        resource: "core",
        lane: "interactive",
      });
    }
    expect(budgetSnapshot(INST).used).toEqual({ interactive: 75, bulk: 25 });
  });

  it("holds the interactive share back from bulk when GitHub reports little left", () => {
    // Another process already spent most of the hour: 60 left of 100.
    seed(100, 60, Math.floor(Date.now() / 1000) + 3600);
    // 75 are reserved for interactive, so bulk gets nothing at 60 remaining.
    expect(() =>
      reserveRequest({ installationId: INST, resource: "core", lane: "bulk" }),
    ).toThrow(/held back for interactive/);
    reserveRequest({
      installationId: INST,
      resource: "core",
      lane: "interactive",
    });
  });

  it("lets interactive spill into an idle bulk share", () => {
    seed(100, 100, Math.floor(Date.now() / 1000) + 3600);
    for (let i = 0; i < 90; i++) {
      reserveRequest({
        installationId: INST,
        resource: "core",
        lane: "interactive",
      });
    }
    expect(budgetSnapshot(INST).used.interactive).toBe(90);
  });

  it("refuses everything once GitHub reports none left, until the reset", () => {
    const now = 1_700_000_000_000;
    observeResponse({
      installationId: INST,
      resource: "core",
      now,
      headers: {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 + 600),
      },
    });
    let err: unknown;
    try {
      reserveRequest({
        installationId: INST,
        resource: "core",
        lane: "interactive",
        now: now + 1000,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GithubBudgetError);
    expect((err as GithubBudgetError).retryAfterSeconds).toBe(599);
    // After the reset the window is new.
    reserveRequest({
      installationId: INST,
      resource: "core",
      lane: "interactive",
      now: now + 601_000,
    });
  });

  it("keeps REST and GraphQL in separate windows", () => {
    seed(100, 0, Math.floor(Date.now() / 1000) + 3600);
    expect(() =>
      reserveRequest({ installationId: INST, resource: "core", lane: "interactive" }),
    ).toThrow(GithubBudgetError);
    reserveRequest({
      installationId: INST,
      resource: "graphql",
      lane: "interactive",
    });
  });

  it("ignores headers for a different quota", () => {
    observeResponse({
      installationId: INST,
      resource: "core",
      headers: {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-resource": "code_search",
      },
    });
    expect(budgetSnapshot(INST).remaining).toBeNull();
  });

  it("classifies requests into lanes", () => {
    expect(resourceOf({ url: "/graphql" })).toBe("graphql");
    expect(resourceOf({ url: "/search/issues" })).toBeNull();
    expect(resourceOf({ url: "/repos/{owner}/{repo}/pulls" })).toBe("core");
    expect(
      isLargeRequest({ method: "GET", url: "/repos/{owner}/{repo}/compare/{basehead}" }),
    ).toBe(true);
    expect(isLargeRequest({ method: "GET", url: "/repos/{owner}/{repo}/pulls" })).toBe(true);
    expect(isLargeRequest({ method: "POST", url: "/repos/{owner}/{repo}/pulls" })).toBe(false);
    expect(
      isLargeRequest({ method: "GET", url: "/repos/{owner}/{repo}/pulls/{pull_number}" }),
    ).toBe(false);
    expect(resolveLane({ method: "PATCH", url: "/repos/{owner}/{repo}/check-runs/{id}" })).toBe(
      "interactive",
    );
  });

  it("puts everything inside inBulkLane in the bulk lane", async () => {
    const lane = await inBulkLane(async () => {
      await Promise.resolve();
      return resolveLane({ method: "POST", url: "/repos/{owner}/{repo}/check-runs" });
    });
    expect(lane).toBe("bulk");
  });

  it("wraps requests: counts them and learns the limit from the response", async () => {
    const wrap = budgetWrapper(INST);
    const res = await wrap(
      async () => ({
        data: {},
        headers: { "x-ratelimit-limit": "6850", "x-ratelimit-remaining": "6849" },
      }),
      { method: "GET", url: "/repos/{owner}/{repo}" } as never,
    );
    expect(res).toBeTruthy();
    expect(budgetSnapshot(INST)).toMatchObject({
      limit: 6850,
      remaining: 6849,
      used: { interactive: 1, bulk: 0 },
    });
  });

  it("learns from the headers on an error response too", async () => {
    const wrap = budgetWrapper(INST);
    const boom = Object.assign(new Error("rate limited"), {
      status: 403,
      response: {
        headers: { "x-ratelimit-limit": "6850", "x-ratelimit-remaining": "0" },
      },
    });
    await expect(
      wrap(
        async () => {
          throw boom;
        },
        { method: "GET", url: "/repos/{owner}/{repo}" } as never,
      ),
    ).rejects.toBe(boom);
    expect(budgetSnapshot(INST).remaining).toBe(0);
  });

  it("does not send a refused request", async () => {
    seed(100, 0, Math.floor(Date.now() / 1000) + 3600);
    let sent = false;
    await expect(
      budgetWrapper(INST)(
        async () => {
          sent = true;
          return {};
        },
        { method: "GET", url: "/repos/{owner}/{repo}" } as never,
      ),
    ).rejects.toBeInstanceOf(GithubBudgetError);
    expect(sent).toBe(false);
  });
});

describe("classifyGithubError with rate limits", () => {
  it("makes a budget refusal retryable after the wait", () => {
    const e = new GithubBudgetError("bulk", "core", 120, "spent");
    const out = classifyGithubError(e) as ApplicationFailure;
    expect(out).toBeInstanceOf(ApplicationFailure);
    expect(out.nonRetryable).toBe(false);
    expect(out.type).toBe("GithubRateLimited");
    expect(out.nextRetryDelay).toBe(120_000);
  });

  it("waits for x-ratelimit-reset on a real 403 and clamps it", () => {
    const now = Date.now();
    const e = Object.assign(new Error("rate limit"), {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(now / 1000) + 7200),
        },
      },
    });
    const out = classifyGithubError(e) as ApplicationFailure;
    expect(out.nextRetryDelay).toBe(30 * 60 * 1000);
    expect(rateLimitDelayMs({ response: { headers: {} } })).toBeNull();
  });

  it("still fails a permission 403 for good", () => {
    const e = Object.assign(new Error("forbidden"), { status: 403, response: { headers: {} } });
    const out = classifyGithubError(e) as ApplicationFailure;
    expect(out.nonRetryable).toBe(true);
  });
});
