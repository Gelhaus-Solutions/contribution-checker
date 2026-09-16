import { beforeEach, describe, expect, it, vi } from "vitest";

const handlePullRequestEvent = vi.fn();
const handlePullRequestReviewEvent = vi.fn();

vi.mock("@/lib/github/webhook", () => ({
  handlePullRequestEvent: (...a: unknown[]) => handlePullRequestEvent(...a),
  handlePullRequestReviewEvent: (...a: unknown[]) =>
    handlePullRequestReviewEvent(...a),
  handleInstallationEvent: vi.fn(),
  handleInstallationReposEvent: vi.fn(),
  handleMergeGroupEvent: vi.fn(),
  handlePushEvent: vi.fn(),
  reGatePr: vi.fn(),
}));

vi.mock("@/lib/github/staging", () => ({ reconcileStagingBatch: vi.fn() }));

import { convergePrEvent } from "@/worker/activities/github";

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
