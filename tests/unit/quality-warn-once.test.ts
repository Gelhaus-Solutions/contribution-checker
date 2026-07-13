import { describe, expect, it, vi, beforeEach } from "vitest";

const prQualityUpsert = vi.fn();
const prQualityUpdateMany = vi.fn();
const commentOnPr = vi.fn();
const fetchPrContext = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    prQuality: {
      upsert: (...args: unknown[]) => prQualityUpsert(...args),
      updateMany: (...args: unknown[]) => prQualityUpdateMany(...args),
    },
  },
}));

vi.mock("@sentry/nextjs", () => ({
  metrics: { distribution: vi.fn() },
}));

vi.mock("@/lib/quality/fetch", () => ({
  fetchPrContext: (...args: unknown[]) => fetchPrContext(...args),
}));

vi.mock("@/lib/quality/registry", () => ({
  ALL_HEURISTICS: [
    {
      id: "h1",
      label: "Heuristic One",
      run: () => ({ failed: true, reason: "flagged" }),
    },
  ],
  isHeuristicEnabled: () => true,
  parseHoneypots: () => [],
  parseQualityConfig: () => ({}),
  thresholdFor: () => undefined,
}));

vi.mock("@/lib/quality/score", () => ({
  computeScore: () => ({ score: 10, failedIds: ["h1"], passedIds: [] }),
}));

vi.mock("@/lib/github/pr-actions", () => ({
  commentOnPr: (...args: unknown[]) => commentOnPr(...args),
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
}));

import { runQualityForPrCheck } from "@/lib/quality/run";

const project = {
  id: "proj1",
  qualityEnabled: true,
  qualityConfig: "{}",
  qualityCommentMin: 50,
  prTemplateHoneypots: "[]",
  qualityTemplateMatchPct: 0,
  trackWhenDisabled: false,
  checkerEnabled: true,
};

const baseArgs = {
  prCheckId: "chk1",
  installationId: 1,
  repoFullName: "acme/repo",
  prNumber: 7,
  project,
};

beforeEach(() => {
  prQualityUpsert.mockReset().mockResolvedValue(undefined);
  prQualityUpdateMany.mockReset();
  commentOnPr.mockReset().mockResolvedValue(undefined);
  fetchPrContext.mockReset().mockResolvedValue({
    pr: { title: "t", body: "b" },
    prTemplate: null,
    files: [],
    filesTruncated: false,
    commits: [],
    account: { login: "octocat" },
  });
});

describe("runQualityForPrCheck warning comment", () => {
  it("posts the warning when the claim succeeds", async () => {
    prQualityUpdateMany.mockResolvedValueOnce({ count: 1 });

    const res = await runQualityForPrCheck(baseArgs);

    expect(res?.summary.score).toBe(10);
    expect(prQualityUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { prCheckId: "chk1", warnCommentedAt: null },
      })
    );
    expect(commentOnPr).toHaveBeenCalledTimes(1);
    expect(commentOnPr.mock.calls[0][2]).toContain("quality warning");
  });

  it("does not re-post when the warning was already posted", async () => {
    prQualityUpdateMany.mockResolvedValueOnce({ count: 0 });

    await runQualityForPrCheck(baseArgs);

    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it("releases the claim when posting fails so a re-run can retry", async () => {
    prQualityUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    commentOnPr.mockRejectedValueOnce(new Error("boom"));

    await runQualityForPrCheck(baseArgs);

    expect(prQualityUpdateMany).toHaveBeenCalledTimes(2);
    expect(prQualityUpdateMany.mock.calls[1][0]).toEqual({
      where: { prCheckId: "chk1" },
      data: { warnCommentedAt: null },
    });
  });

  it("skips the claim and the comment when skipComment is set", async () => {
    await runQualityForPrCheck({ ...baseArgs, skipComment: true });

    expect(prQualityUpdateMany).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });
});
