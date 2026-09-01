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
const fastForwardBranch = vi.fn();
const mergeBranch = vi.fn();

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
  fastForwardBranch: (...a: unknown[]) => fastForwardBranch(...a),
  mergeBranch: (...a: unknown[]) => mergeBranch(...a),
}));

import { reconcileStagingBatch, renderBatchBlock } from "@/lib/github/staging";
import { ALL_DIGEST_SECTION_IDS } from "@/lib/github/staging-digest";
import { STAGING_SYNC_WINDOW_MS } from "@/lib/temporal/contracts";
import type { PrSummary } from "@/lib/github/pr-actions";

const AGGREGATE: PrSummary = {
  number: 500,
  title: "Ship staging to production",
  state: "open",
  merged: false,
  mergedAt: null,
  mergeCommitSha: null,
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
    stagingLastSyncAt: null,
    stagingRetargetEnabled: null,
    stagingBatchPrEnabled: null,
    stagingSyncEnabled: null,
    stagingDigestEnabled: null,
    stagingBranch: null,
    project: {
      id: "proj1",
      bypassHandles: "[]",
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingSyncEnabled: true,
      // Off by default here as in the schema: the digest tests opt in.
      stagingDigestEnabled: false,
      stagingDigestSections: "[]",
      stagingBranch: "staging",
      labelStagingBatch: "staging:batch",
      labelStagingIgnore: "staging:ignore",
      labelStagingRepoint: "staging:repoint",
    },
    ...overrides,
  };
}

/** The same repo with the digest switched on project-wide. */
function digestOn(overrides: Record<string, unknown> = {}) {
  const repo = makeRepo(overrides);
  return {
    ...repo,
    project: {
      ...repo.project,
      stagingDigestEnabled: true,
      stagingDigestSections: JSON.stringify(ALL_DIGEST_SECTION_IDS),
    },
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
    fastForwardBranch,
    mergeBranch,
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
  batchPrs = [];
  openAggregatePrs = [];
  // Keyed on the query, not the call order: the batch listing (state "all")
  // and the aggregate lookup (state "open") are distinct questions, and
  // order-coupled mocks break whenever the sequence shifts.
  listPullRequests.mockImplementation(
    (_ref: unknown, opts: { state?: string }) =>
      Promise.resolve(opts.state === "all" ? batchPrs : openAggregatePrs),
  );
});

/** PRs based on the staging branch, in any state. */
let batchPrs: PrLike[] = [];
/** Open staging -> default PRs, i.e. aggregate PR candidates. */
let openAggregatePrs: PrLike[] = [];

type PrLike = PrSummary;

/** A PR merged into staging, the only kind the manifest lists. */
function mergedPr(
  number: number,
  title: string,
  author = "octocat",
  mergedAt = "2026-08-16T00:00:00Z",
): PrLike {
  return {
    ...AGGREGATE,
    number,
    title,
    state: "closed",
    merged: true,
    mergedAt,
    baseRef: "staging",
    headRef: `feature-${number}`,
    authorLogin: author,
    labels: [],
  };
}

describe("staging sync with the default branch", () => {
  it("fast-forwards staging when it has no commits of its own", async () => {
    // The named case: nothing merged into staging yet, but main moved on.
    compareBranches.mockResolvedValue({
      aheadBy: 0,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    getBranchSha.mockResolvedValue("sha-main");
    fastForwardBranch.mockResolvedValue(true);
    getPullRequest.mockResolvedValue(null);

    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(fastForwardBranch).toHaveBeenCalledWith(
      expect.anything(),
      "staging",
      "sha-main",
    );
    // A fast-forward leaves staging equal to main, so there is no batch to open.
    expect(mergeBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(res.synced).toBe(true);
  });

  it("merges rather than fast-forwards when staging has its own work", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    mergeBranch.mockResolvedValue({ merged: true });

    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(fastForwardBranch).not.toHaveBeenCalled();
    expect(mergeBranch).toHaveBeenCalledWith(
      expect.anything(),
      "staging",
      "main",
      expect.any(String),
    );
    expect(res.synced).toBe(true);
  });

  it("falls back to a merge when a fast-forward loses a race", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 0,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    getBranchSha.mockResolvedValue("sha-main");
    fastForwardBranch.mockResolvedValue(false); // someone pushed to staging
    mergeBranch.mockResolvedValue({ merged: true });
    getPullRequest.mockResolvedValue(null);

    await reconcileStagingBatch({ repoId: "repo1" });
    expect(mergeBranch).toHaveBeenCalled();
  });

  it("does nothing when staging is not behind", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 0,
      mergeBaseDate: null,
    });
    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(fastForwardBranch).not.toHaveBeenCalled();
    expect(mergeBranch).not.toHaveBeenCalled();
    expect(res.synced).toBe(false);
  });

  it("defers the sync while the batching window is still open", async () => {
    // Reported, not dropped: the entity comes back for it when the window
    // closes, so a burst of pushes to main costs one merge commit, not one
    // per push. The window is measured from the repo row, so it holds even
    // though this is a fresh call with no entity state behind it.
    const lastSync = new Date(Date.now() - 60_000);
    repoFindUnique.mockResolvedValue(
      makeRepo({ stagingLastSyncAt: lastSync }),
    );
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 3,
      mergeBaseDate: null,
    });
    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(mergeBranch).not.toHaveBeenCalled();
    expect(fastForwardBranch).not.toHaveBeenCalled();
    expect(res.syncDeferred).toBe(true);
    expect(res.syncEligibleAtMs).toBe(
      lastSync.getTime() + STAGING_SYNC_WINDOW_MS,
    );
    // The manifest is still refreshed: only the branch write is rate-limited.
    expect(updatePullRequestBody).toHaveBeenCalled();
  });

  it("syncs again once the window has elapsed, and stamps the repo", async () => {
    repoFindUnique.mockResolvedValue(
      makeRepo({
        stagingLastSyncAt: new Date(Date.now() - STAGING_SYNC_WINDOW_MS - 1000),
      }),
    );
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    mergeBranch.mockResolvedValue({ merged: true });

    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(mergeBranch).toHaveBeenCalled();
    expect(res.synced).toBe(true);
    expect(res.syncDeferred).toBe(false);
    // The stamp is what makes the next window hold; without it the entity
    // would sync again on the very next push.
    expect(repoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "repo1" },
        data: { stagingLastSyncAt: expect.any(Date) },
      }),
    );
  });

  it("leaves the window open when the sync wrote nothing", async () => {
    // A conflict is a state for a human. Starting a window on it would make
    // the resolved branch wait hours for its next sync.
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    mergeBranch.mockResolvedValue({ failure: "conflict" });

    await reconcileStagingBatch({ repoId: "repo1" });
    expect(repoUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { stagingLastSyncAt: expect.any(Date) },
      }),
    );
  });

  it("reports a merge conflict instead of throwing", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 2,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    mergeBranch.mockResolvedValue({ failure: "conflict" });

    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(res.synced).toBe(false);
    // The batch still reconciles; only the branch is left for a human.
    expect(updatePullRequestBody).toHaveBeenCalled();
  });

  it("skips syncing without contents:write", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 0,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(false);
    getPullRequest.mockResolvedValue(null);

    await reconcileStagingBatch({ repoId: "repo1" });
    expect(fastForwardBranch).not.toHaveBeenCalled();
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("syncs a repo that only retargets, with no aggregate PR", async () => {
    repoFindUnique.mockResolvedValue(
      makeRepo({
        project: { ...makeRepo().project, stagingBatchPrEnabled: false },
      }),
    );
    compareBranches.mockResolvedValue({
      aheadBy: 0,
      behindBy: 3,
      mergeBaseDate: null,
    });
    installationHasContentsWrite.mockResolvedValue(true);
    getBranchSha.mockResolvedValue("sha-main");
    fastForwardBranch.mockResolvedValue(true);

    const res = await reconcileStagingBatch({ repoId: "repo1" });
    expect(res.synced).toBe(true);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(updatePullRequestBody).not.toHaveBeenCalled();
  });
});

describe("reconcileStagingBatch", () => {
  it("does nothing when staging routing is off entirely", async () => {
    repoFindUnique.mockResolvedValue(
      makeRepo({
        project: {
          ...makeRepo().project,
          stagingRetargetEnabled: false,
          stagingBatchPrEnabled: false,
        },
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
    batchPrs = [mergedPr(12, "Fix the retry backoff")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const [, prNumber, body] = updatePullRequestBody.mock.calls[0];
    expect(prNumber).toBe(500);
    expect(body).toContain("- #12 by @octocat");
  });

  it("leaves an open PR on staging out of the manifest", async () => {
    // Only what actually landed is in the batch; an open PR may never merge.
    batchPrs = [
      {
        ...mergedPr(13, "Still in review"),
        state: "open",
        merged: false,
        mergedAt: null,
      },
    ];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).not.toContain("#13");
    expect(body).toContain("No merged PRs in this batch yet");
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
    batchPrs = [mergedPr(12, "New thing", "hubot")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body.startsWith("Ship on Friday.")).toBe(true);
    expect(body).toContain("- #12 by @hubot");
  });

  it("falls back to a head/base search when the tracked number is stale", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: 404 }));
    getPullRequest.mockResolvedValue(null);
    openAggregatePrs = [{ ...AGGREGATE, number: 501 }];
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
    createPullRequest.mockResolvedValue({ number: 600 });
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

  it("opens the aggregate PR with its manifest already filled in", async () => {
    // GitHub fires pull_request.opened with the body the create call carried,
    // and that snapshot is what Slack/Discord/email quote. Creating it empty
    // and PATCHing afterwards makes every integration announce an empty batch.
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    batchPrs = [
      mergedPr(12, "Fix the retry backoff"),
      mergedPr(13, "Add German translations", "hubot"),
    ];
    createPullRequest.mockResolvedValue({ number: 600 });
    await reconcileStagingBatch({ repoId: "repo1" });

    const body = createPullRequest.mock.calls[0][1].body as string;
    expect(body).toContain("- #12 by @octocat");
    expect(body).toContain("- #13 by @hubot");
    expect(body).not.toContain("No merged PRs in this batch yet");
    // And the body it was born with is already correct, so opening one costs
    // no follow-up edit in the PR timeline.
    expect(updatePullRequestBody).not.toHaveBeenCalled();
  });

  it("treats a no-commits 422 as an ordinary state, not an error", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    createPullRequest.mockResolvedValue({ failure: "no_commits" });
    await expect(
      reconcileStagingBatch({ repoId: "repo1" }),
    ).resolves.toEqual({
      synced: false,
      syncDeferred: false,
      syncEligibleAtMs: null,
    });
    expect(updatePullRequestBody).not.toHaveBeenCalled();
  });

  it("adopts the winner when a concurrent run already created the PR", async () => {
    repoFindUnique.mockResolvedValue(makeRepo({ stagingBatchPrNumber: null }));
    // Nothing on the first lookup; the concurrent winner appears on the retry
    // after our own create 422s.
    listPullRequests.mockImplementation(
      (_ref: unknown, opts: { state?: string }) => {
        if (opts.state === "all") return Promise.resolve([]);
        return Promise.resolve(
          createPullRequest.mock.calls.length === 0
            ? []
            : [{ ...AGGREGATE, number: 601 }],
        );
      },
    );
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

  it("carries the digest into the aggregate PR body", async () => {
    repoFindUnique.mockResolvedValue(digestOn());
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: null,
      commitShas: ["c1"],
      commitParents: { c1: [] },
      commitMessages: { c1: "feat(api)!: rename the config key" },
      files: [
        {
          filename: ".env.example",
          previousFilename: null,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@\n+SENTRY_DSN=",
        },
        {
          filename: "prisma/migrations/20260101_x/migration.sql",
          previousFilename: null,
          status: "added",
          additions: 4,
          deletions: 0,
          patch: null,
        },
      ],
      filesTruncated: false,
      truncated: false,
    });
    batchPrs = [mergedPr(2, "New", "octocat", "2026-08-12T00:00:00Z")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).toContain("- #2");
    expect(body).toContain("### Before you merge");
    expect(body).toContain("`SENTRY_DSN`");
    expect(body).toContain("Database migrations");
    expect(body).toContain("Breaking changes");
  });

  // Existing projects must not wake up to a differently-shaped release PR.
  it("leaves the digest out until the project turns it on", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: null,
      commitShas: ["c1"],
      commitParents: { c1: [] },
      commitMessages: { c1: "feat: x" },
      files: [
        {
          filename: ".env.example",
          previousFilename: null,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@\n+SENTRY_DSN=",
        },
      ],
      filesTruncated: false,
      truncated: false,
    });
    batchPrs = [mergedPr(2, "New", "octocat", "2026-08-12T00:00:00Z")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).toContain("- #2");
    expect(body).not.toContain("Before you merge");
    expect(body).not.toContain("SENTRY_DSN");
  });

  it("honors the project's section list", async () => {
    repoFindUnique.mockResolvedValue({
      ...digestOn(),
      project: {
        ...digestOn().project,
        stagingDigestSections: '["migrations"]',
      },
    });
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: null,
      commitShas: ["c1"],
      commitParents: { c1: [] },
      commitMessages: { c1: "feat: x" },
      files: [
        {
          filename: ".env.example",
          previousFilename: null,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@\n+SENTRY_DSN=",
        },
        {
          filename: "prisma/migrations/20260101_x/migration.sql",
          previousFilename: null,
          status: "added",
          additions: 4,
          deletions: 0,
          patch: null,
        },
      ],
      filesTruncated: false,
      truncated: false,
    });
    batchPrs = [mergedPr(2, "New", "octocat", "2026-08-12T00:00:00Z")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).toContain("Database migrations");
    expect(body).not.toContain("SENTRY_DSN");
  });

  // The digest is advisory; the manifest is not. A digest that blows up must
  // cost the release PR its heads-up section, never its list of PRs.
  it("still writes the manifest when the digest cannot be built", async () => {
    repoFindUnique.mockResolvedValue(digestOn());
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: null,
      commitShas: ["c1"],
      commitParents: { c1: [] },
      commitMessages: { c1: "feat: x" },
      // Not an array: whatever GitHub did, the reconcile has to survive it.
      files: 42,
      filesTruncated: false,
      truncated: false,
    });
    batchPrs = [mergedPr(2, "New", "octocat", "2026-08-12T00:00:00Z")];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).toContain("- #2");
    expect(body).not.toContain("Before you merge");
  });

  it("excludes PRs already shipped by the previous batch", async () => {
    compareBranches.mockResolvedValue({
      aheadBy: 1,
      behindBy: 0,
      mergeBaseDate: "2026-08-10T00:00:00Z",
    });
    batchPrs = [
      mergedPr(1, "Old", "octocat", "2026-08-01T00:00:00Z"),
      mergedPr(2, "New", "octocat", "2026-08-12T00:00:00Z"),
    ];
    await reconcileStagingBatch({ repoId: "repo1" });
    const body = updatePullRequestBody.mock.calls[0][2] as string;
    expect(body).not.toContain("#1");
    expect(body).toContain("- #2");
  });
});
