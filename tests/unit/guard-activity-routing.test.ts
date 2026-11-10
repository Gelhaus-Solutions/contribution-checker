import { beforeEach, describe, expect, it, vi } from "vitest";

const handlePullRequestEvent = vi.fn();
const handlePullRequestReviewEvent = vi.fn();
const reGatePr = vi.fn();
const handleMergeGroupEvent = vi.fn();
const handlePushEvent = vi.fn();
const reconcileStagingBatch = vi.fn();

vi.mock("@/lib/github/webhook", () => ({
  handlePullRequestEvent: (...a: unknown[]) => handlePullRequestEvent(...a),
  handlePullRequestReviewEvent: (...a: unknown[]) =>
    handlePullRequestReviewEvent(...a),
  handleInstallationEvent: vi.fn(),
  handleInstallationReposEvent: vi.fn(),
  handleMergeGroupEvent: (...a: unknown[]) => handleMergeGroupEvent(...a),
  handlePushEvent: (...a: unknown[]) => handlePushEvent(...a),
  reGatePr: (...a: unknown[]) => reGatePr(...a),
}));

vi.mock("@/lib/github/staging", () => ({
  reconcileStagingBatch: (...a: unknown[]) => reconcileStagingBatch(...a),
}));

vi.mock("@/lib/github/budget", () => ({
  inBulkLane: <T>(work: () => Promise<T>) => work(),
}));

import { ApplicationFailure } from "@temporalio/common";
import { GmintRefusal, noteGmintOutage } from "@/lib/github/gmint-tokens";
import {
  convergePrEvent,
  convergePrReGate,
  convergeStagingBatch,
  processMergeGroupEvent,
  processPushEvent,
} from "@/worker/activities/github";

beforeEach(() => {
  vi.clearAllMocks();
  handlePullRequestEvent.mockResolvedValue({ terminal: false });
  handlePullRequestReviewEvent.mockResolvedValue(undefined);
});

const envelope = (eventName: string) => ({
  eventName,
  deliveryId: "d1",
  payload: { action: "submitted" },
});

describe("convergePrEvent", () => {
  it("routes a pull_request envelope to the PR handler", async () => {
    await convergePrEvent(envelope("pull_request"));
    expect(handlePullRequestEvent).toHaveBeenCalledTimes(1);
    expect(handlePullRequestReviewEvent).not.toHaveBeenCalled();
  });

  it("routes a review envelope to the review handler", async () => {
    await convergePrEvent(envelope("pull_request_review"));
    expect(handlePullRequestReviewEvent).toHaveBeenCalledTimes(1);
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  // Reporting terminal would complete the per-PR entity while the PR is still
  // open, and every later event would have to start a fresh one.
  it("never reports a review as terminal", async () => {
    const res = await convergePrEvent(envelope("pull_request_review"));
    expect(res).toEqual({ terminal: false });
  });

  it("still surfaces a terminal PR event", async () => {
    handlePullRequestEvent.mockResolvedValue({ terminal: true });
    const res = await convergePrEvent(envelope("pull_request"));
    expect(res.terminal).toBe(true);
  });
});

// Every GitHub write catches and logs its own failure, so a PR gated while GMint
// was down used to complete with no check, no label and no comment, and nothing
// ever asked again (the vps1 outage of 2026-11-09).
describe("a converge while GMint is not answering", () => {
  const outage = () =>
    new GmintRefusal("transport", 503, true, "GMint is not answering");

  it("is refused as GmintUnavailable when a write swallowed the outage", async () => {
    handlePullRequestEvent.mockImplementation(async () => {
      try {
        throw outage();
      } catch (e) {
        // What every publisher does: note nothing, log, carry on.
        noteGmintOutage(e);
      }
      return { terminal: false };
    });
    const failure = await convergePrEvent(envelope("pull_request")).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe("GmintUnavailable");
    // prGate waits on a timer; eight quick attempts cannot outlast it.
    expect(failure.nonRetryable).toBe(true);
  });

  it("is refused the same way when the converge cannot go on without GMint", async () => {
    reGatePr.mockRejectedValue(outage());
    const failure = await convergePrReGate({ repoId: "1", prNumber: 2 }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe("GmintUnavailable");
  });

  it("is not refused for a lockdown or a refusal, which waiting does not cure", async () => {
    handlePullRequestEvent.mockImplementation(async () => {
      noteGmintOutage(new GmintRefusal("locked_down", 503, false, "locked"));
      noteGmintOutage(new GmintRefusal("denied", 403, false, "no"));
      return { terminal: false };
    });
    await expect(convergePrEvent(envelope("pull_request"))).resolves.toEqual({
      terminal: false,
    });
  });

  it("does not leak into the next converge", async () => {
    handlePullRequestEvent.mockImplementationOnce(async () => {
      noteGmintOutage(outage());
      return { terminal: false };
    });
    await convergePrEvent(envelope("pull_request")).catch(() => undefined);
    await expect(convergePrEvent(envelope("pull_request"))).resolves.toEqual({
      terminal: false,
    });
  });
});

// Push, merge group and staging batch work wrote nothing while GMint was down
// and reported success all the same: a CLA version never published, a queue
// commit without checks, a release PR whose manifest stayed stale.
describe("other GitHub work while GMint is not answering", () => {
  const swallowed = async () => {
    try {
      throw new GmintRefusal("transport", 503, true, "GMint is not answering");
    } catch (e) {
      noteGmintOutage(e);
    }
  };

  it("refuses a push as GmintUnavailable", async () => {
    handlePushEvent.mockImplementation(swallowed);
    const failure = await processPushEvent({}).catch((e) => e);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe("GmintUnavailable");
  });

  it("refuses a merge group as GmintUnavailable", async () => {
    handleMergeGroupEvent.mockImplementation(swallowed);
    const failure = await processMergeGroupEvent({}).catch((e) => e);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe("GmintUnavailable");
  });

  it("refuses a staging reconcile that could not read GitHub", async () => {
    reconcileStagingBatch.mockRejectedValue(
      new GmintRefusal("transport", 503, true, "GMint is not answering"),
    );
    const failure = await convergeStagingBatch({ repoId: "r1" }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.type).toBe("GmintUnavailable");
  });

  it("lets the same work through once GMint answers", async () => {
    handlePushEvent.mockResolvedValue(undefined);
    await expect(processPushEvent({})).resolves.toBeUndefined();
  });
});
