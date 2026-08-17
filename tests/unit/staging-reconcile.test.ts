import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const repoUpdate = vi.fn();

const getPullRequest = vi.fn();
const listPullRequests = vi.fn();
const createPullRequest = vi.fn();
const updatePullRequestBody = vi.fn();
const compareBranches = vi.fn();
const getBranchSha = vi.fn();
const createBranch = vi.fn();
const getRepoDefaultBranch = vi.fn();
const installationHasContentsWrite = vi.fn();
const ensureLabel = vi.fn();
const addLabel = vi.fn();
const setPullRequestBase = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => repoFindUnique(...a),
      update: (...a: unknown[]) => repoUpdate(...a),
    },
  },
}));

vi.mock("@/lib/github/pr-actions", () => ({
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
  getPullRequest: (...a: unknown[]) => getPullRequest(...a),
  listPullRequests: (...a: unknown[]) => listPullRequests(...a),
  createPullRequest: (...a: unknown[]) => createPullRequest(...a),
  updatePullRequestBody: (...a: unknown[]) => updatePullRequestBody(...a),
  compareBranches: (...a: unknown[]) => compareBranches(...a),
  getBranchSha: (...a: unknown[]) => getBranchSha(...a),
  createBranch: (...a: unknown[]) => createBranch(...a),
  getRepoDefaultBranch: (...a: unknown[]) => getRepoDefaultBranch(...a),
  installationHasContentsWrite: (...a: unknown[]) =>
    installationHasContentsWrite(...a),
  ensureLabel: (...a: unknown[]) => ensureLabel(...a),
  addLabel: (...a: unknown[]) => addLabel(...a),
  setPullRequestBase: (...a: unknown[]) => setPullRequestBase(...a),
}));

import { reconcileStagingBatch, renderBatchBlock } from "@/lib/github/staging";

const AGGREGATE = {
  number: 500,
  title: "Ship staging to production",
  state: "open" as const,
  merged: false,
  mergedAt: null,
  body: null as string | null,
  baseRef: "main",
  headRef: "staging",
  authorLogin: "cc[bot]",
  labels: ["staging:batch"],
};

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo1",
    fullName: "postiz/postiz",
    installationId: 99,
    active: true,
    defaultBranch: "main",
    stagingBatchPrNumber: 500,
    stagingBatchSince: null,
    project: {
      id: "proj1",
      bypassHandles: "[]",
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingBranch: "staging",
      labelStagingBatch: "staging:batch",
      labelStagingOptOut: "staging:opt-out",
    },
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    repoFindUnique,
    repoUpdate,
    getPullRequest,
    listPullRequests,
    createPullRequest,
    updatePullRequestBody,
    compareBranches,
    getBranchSha,
    createBranch,
    getRepoDefaultBranch,
    installationHasContentsWrite,
    ensureLabel,
    addLabel,
    setPullRequestBase,
  ]) {
    fn.mockReset();
  }
  repoFindUnique.mockResolvedValue(makeRepo());
  repoUpdate.mockResolvedValue({});
  getBranchSha.mockResolvedValue("sha-staging");
  compareBranches.mockResolvedValue({
    aheadBy: 2,
    behindBy: 0,
    mergeBaseDate: null,
  });
  getPullRequest.mockResolvedValue({ ...AGGREGATE });
  listPullRequests.mockResolvedValue([]);
});

describe("reconcileStagingBatch", () => {
  it("does nothing when the batch feature is off", async () => {
    repoFindUnique.mockResolvedValue(
      makeRepo({
        project: { ...makeRepo().project, stagingBatchPrEnabled: false },
      }),
    );
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(compareBranches).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("does nothing for a CI-mode repo with no installation", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ installationId: null }));
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(compareBranches).not.toHaveBeenCalled();
  });

  it("does not open an empty PR when staging is not ahead", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 0,
      behindBy: 0,
      mergeBaseDate: null,
    });
    getPullRequest.mockResolvedValue(null);
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(createPullRequest).not.toHaveBeenCalled();
    // The tracked PR is gone, so the tracking is cleared for the next batch.
    expect(repoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stagingBatchPrNumber: null }),
      }),
    );
  });

  it("refreshes the manifest of the tracked aggregate PR", async () => {
    listPullRequests.mockResolvedValue([
      {
        ...AGGREGATE,
        number: 12,
        title: "Fix the retry backoff",
        baseRef: "staging",
        headRef: "fix",
        authorLogin: "octocat",
        labels: [],
      },
    ]);
    await reconcileStagingBatch({ repoId: "repo1" });
    const [, prNumber, body] = updatePullRequestBody.mock.calls[0];
    expect(prNumber).toBe(500);
    expect(body).toContain("- Fix the retry backoff (#12 by @octocat)");
  });

  it("does not PATCH the body when the rendered block is unchanged", async () => {
    getPullRequest.mockResolvedValue({
      ...AGGREGATE,
      body: renderBatchBlock([]),
    });
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(updatePullRequestBody).not.toHaveBeenCalled();
  });

  it("preserves human prose written outside the markers", async () => {
    getPullRequest.mockResolvedValue({
      ...AGGREGATE,
      body: `Ship on Friday.\n\n${renderBatchBlock([])}`,
    });
    listPullRequests.mockResolvedValue([
      {
        ...AGGREGATE,
        number: 12,
        title: "New thing",
        baseRef: "staging",
        headRef: "x",
        authorLogin: "hubot",
        labels: [],
      },
    ]);
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body.startsWith("Ship on Friday.")).toBe(true);
    expect(body).toContain("- New thing (#12 by @hubot)");
  });

  it("falls back to a head/base search when the tracked number is stale", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: 404 }));
    getPullRequest.mockResolvedValue(null);
    listPullRequests
      .mockResolvedValueOnce([{ ...AGGREGATE, number: 501 }])
      .mockResolvedValueOnce([]);
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(repoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stagingBatchPrNumber: 501 }),
      }),
    );
  });

  it("creates the aggregate PR when none exists, and labels it", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    listPullRequests.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    createPullRequest.mockResolvedValue({ number: 600 });
    getPullRequest.mockResolvedValue({
      ...AGGREGATE,
      number: 600,
      labels: [],
    });
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ head: "staging", base: "main" }),
    );
    expect(addLabel).toHaveBeenCalledWith(
      expect.anything(),
      600,
      "staging:batch",
    );
  });

  it("treats a no-commits 422 as an ordinary state, not an error", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    listPullRequests.mockResolvedValue([]);
    createPullRequest.mockResolvedValue({ failure: "no_commits" });
    await expect(
      reconcileStagingBatch({ repoId: "repo1" }),
    ).resolves.toBeUndefined();
    expect(updatePullRequestBody).not.toHaveBeenCalled();
  });

  it("adopts the winner when a concurrent run already created the PR", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    listPullRequests
      .mockResolvedValueOnce([]) // first find: nothing
      .mockResolvedValueOnce([{ ...AGGREGATE, number: 601 }]) // after 422
      .mockResolvedValueOnce([]); // batch listing
    createPullRequest.mockResolvedValue({ failure: "already_exists" });
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(repoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stagingBatchPrNumber: 601 }),
      }),
    );
  });

  it("skips branch creation when the installation lacks contents:write", async () => {
    getBranchSha.mockResolvedValue(null);
    installationHasContentsWrite.mockResolvedValue(false);
    await reconcileStagingBatch({ repoId: "repo1" });
    expect(createBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("excludes PRs already shipped by the previous batch", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: "2026-08-10T00:00:00Z",
    });
    listPullRequests.mockResolvedValue([
      {
        ...AGGREGATE,
        number: 1,
        title: "Old",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-01T00:00:00Z",
        baseRef: "staging",
        labels: [],
      },
      {
        ...AGGREGATE,
        number: 2,
        title: "New",
        state: "closed",
        merged: true,
        mergedAt: "2026-08-12T00:00:00Z",
        baseRef: "staging",
        labels: [],
      },
    ]);
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).not.toContain("#1");
    expect(body).toContain("- New (#2");
  });
});
