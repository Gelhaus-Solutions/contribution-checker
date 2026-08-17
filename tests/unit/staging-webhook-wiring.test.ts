import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const repoUpdate = vi.fn();
const prCheckFindUnique = vi.fn();

const setPullRequestBase = vi.fn();
const getBranchSha = vi.fn();
const installationHasContentsWrite = vi.fn();
const signalStagingBatch = vi.fn();
const decideForPR = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => repoFindUnique(...a),
      update: (...a: unknown[]) => repoUpdate(...a),
    },
    prCheck: { findUnique: (...a: unknown[]) => prCheckFindUnique(...a) },
  },
}));

vi.mock("@/lib/github/pr-actions", () => ({
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
  setPullRequestBase: (...a: unknown[]) => setPullRequestBase(...a),
  getBranchSha: (...a: unknown[]) => getBranchSha(...a),
  installationHasContentsWrite: (...a: unknown[]) =>
    installationHasContentsWrite(...a),
  getRepoDefaultBranch: vi.fn(async () => null),
  createBranch: vi.fn(async () => true),
  getPullRequest: vi.fn(async () => null),
  listPullRequests: vi.fn(async () => []),
  createPullRequest: vi.fn(async () => ({ failure: "no_commits" as const })),
  updatePullRequestBody: vi.fn(),
  compareBranches: vi.fn(async () => null),
  ensureLabel: vi.fn(),
  addLabel: vi.fn(),
  closePullRequest: vi.fn(),
  reopenPullRequest: vi.fn(),
  removeLabelIfPresent: vi.fn(),
  setLabels: vi.fn(),
  commentOnPr: vi.fn(),
  prHasCommentContaining: vi.fn(async () => false),
}));

vi.mock("@/lib/temporal/start", () => ({
  signalStagingBatch: (...a: unknown[]) => signalStagingBatch(...a),
}));

vi.mock("@/lib/applications/decide-pr", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/applications/decide-pr")
  >("@/lib/applications/decide-pr");
  return { ...actual, decideForPR: (...a: unknown[]) => decideForPR(...a) };
});

import { handlePullRequestEvent } from "@/lib/github/webhook";

const PROJECT = {
  id: "proj1",
  bypassHandles: "[]",
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingBranch: "staging",
  labelStagingBatch: "staging:batch",
  labelStagingOptOut: "staging:opt-out",
};

const REPO = {
  id: "repo1",
  fullName: "postiz/postiz",
  installationId: 99,
  active: true,
  defaultBranch: "main",
  stagingBatchPrNumber: null as number | null,
  stagingBatchSince: null,
  project: PROJECT,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 99 },
    repository: {
      id: 1,
      full_name: "postiz/postiz",
      name: "postiz",
      owner: { login: "postiz" },
      default_branch: "main",
    },
    pull_request: {
      number: 42,
      node_id: "n42",
      state: "open",
      user: { login: "octocat", id: 7, type: "User" },
      head: { sha: "abc", ref: "feature", repo: { full_name: "fork/postiz" } },
      base: { ref: "main", repo: { default_branch: "main" } },
      labels: [] as Array<{ name: string }>,
    },
    ...overrides,
  };
}

/** The default payload with a different PR number, for fuse isolation. */
function prNumbered(number: number) {
  const p = payload();
  return { ...p, pull_request: { ...p.pull_request, number } };
}

beforeEach(() => {
  for (const fn of [
    repoFindUnique,
    repoUpdate,
    prCheckFindUnique,
    setPullRequestBase,
    getBranchSha,
    installationHasContentsWrite,
    signalStagingBatch,
    decideForPR,
  ]) {
    fn.mockReset();
  }
  repoFindUnique.mockResolvedValue({ ...REPO });
  repoUpdate.mockResolvedValue({});
  prCheckFindUnique.mockResolvedValue(null);
  getBranchSha.mockResolvedValue("sha-staging");
  // Stop the gate pipeline immediately; these tests are about staging wiring.
  decideForPR.mockResolvedValue({ status: "IGNORED", reason: "test" });
});

describe("staging routing wiring in handlePullRequestEvent", () => {
  it("retargets a PR opened against the default branch", async () => {
    const res = await handlePullRequestEvent(payload() as never);
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      42,
      "staging",
    );
    expect(signalStagingBatch).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "repo1", reason: "pr_retargeted" }),
    );
    expect(res.staging).toEqual({ retargeted: true, outcome: "retargeted" });
  });

  // gitroomhq/postiz-app#1908: the same branch had already been merged into
  // staging by an earlier PR, so GitHub refused the base change and the PR
  // stayed on main, where merging it bypassed the batch entirely. Nothing can
  // retarget it, but the outcome must be named rather than a bare stack trace.
  // Distinct PR numbers: the ping-pong fuse is keyed per PR and module-level,
  // so reusing 42 would spend the budget the later tests rely on.
  it("names the case where the head branch is already merged into staging", async () => {
    setPullRequestBase.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Validation Failed: {"message":"There are no new commits between ` +
            `base branch 'staging' and head branch 'feat/x'"}`,
        ),
        { status: 422 },
      ),
    );
    const res = await handlePullRequestEvent(prNumbered(43) as never);
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "already_in_staging",
    });
  });

  it("reports an unexpected retarget failure as an error, not a skip", async () => {
    setPullRequestBase.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    const res = await handlePullRequestEvent(prNumbered(44) as never);
    expect(res.staging).toEqual({ retargeted: false, outcome: "error" });
  });

  it("does not retarget the echo of its own base change", async () => {
    // Our PATCH comes back as pull_request.edited with the base already moved.
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { base: { ref: { from: "main" } } },
        pull_request: {
          ...payload().pull_request,
          base: { ref: "staging", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });

  it("rewrites the base back when a human moves it to the default branch", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { base: { ref: { from: "staging" } } },
      }) as never,
    );
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      42,
      "staging",
    );
  });

  it("ignores an edit that changed neither the base nor the title", async () => {
    await handlePullRequestEvent(
      payload({ action: "edited", changes: { body: { from: "x" } } }) as never,
    );
    expect(repoFindUnique).not.toHaveBeenCalled();
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });

  it("never runs the gate for a title edit", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { title: { from: "old" } },
        pull_request: {
          ...payload().pull_request,
          base: { ref: "staging", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(decideForPR).not.toHaveBeenCalled();
    expect(signalStagingBatch).toHaveBeenCalled();
  });

  it("never runs the gate on the bot's own aggregate PR", async () => {
    // Without this the gate finds no application, calls it PENDING, and the
    // bot closes its own release PR with an apply link.
    repoFindUnique.mockResolvedValue({ ...REPO, stagingBatchPrNumber: 42 });
    await handlePullRequestEvent(payload() as never);
    expect(decideForPR).not.toHaveBeenCalled();
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });


  it("recognizes an untracked staging -> default PR as the aggregate PR", async () => {
    await handlePullRequestEvent(
      payload({
        pull_request: {
          ...payload().pull_request,
          head: {
            sha: "abc",
            ref: "staging",
            repo: { full_name: "postiz/postiz" },
          },
        },
      }) as never,
    );
    expect(decideForPR).not.toHaveBeenCalled();
  });

  it("leaves a PR alone when it carries the opt-out label", async () => {
    await handlePullRequestEvent(
      payload({
        pull_request: {
          ...payload().pull_request,
          labels: [{ name: "staging:opt-out" }],
        },
      }) as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
    expect(decideForPR).toHaveBeenCalled();
  });

  it("leaves bypass-list accounts on the default branch", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      project: { ...PROJECT, bypassHandles: '["*[bot]"]' },
    });
    await handlePullRequestEvent(
      payload({
        pull_request: {
          ...payload().pull_request,
          user: { login: "dependabot[bot]", id: 9, type: "Bot" },
        },
      }) as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });

  it("does not retarget when the feature is off, but still gates", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      project: { ...PROJECT, stagingRetargetEnabled: false },
    });
    await handlePullRequestEvent(payload() as never);
    expect(setPullRequestBase).not.toHaveBeenCalled();
    expect(decideForPR).toHaveBeenCalled();
  });
});

describe("PR close handling", () => {
  it("refreshes the batch when a PR on staging closes", async () => {
    await handlePullRequestEvent(
      payload({
        action: "closed",
        pull_request: {
          ...payload().pull_request,
          state: "closed",
          merged: true,
          merged_at: "2026-08-17T00:00:00Z",
          base: { ref: "staging", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(signalStagingBatch).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "pr_merged_to_staging" }),
    );
  });

  it("clears tracking when the aggregate PR merges, and does not reopen one", async () => {
    repoFindUnique.mockResolvedValue({ ...REPO, stagingBatchPrNumber: 42 });
    const res = await handlePullRequestEvent(
      payload({
        action: "closed",
        pull_request: {
          ...payload().pull_request,
          state: "closed",
          merged: true,
          merged_at: "2026-08-17T00:00:00Z",
          base: { ref: "main", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(repoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stagingBatchPrNumber: null,
          stagingBatchSince: new Date("2026-08-17T00:00:00Z"),
        }),
      }),
    );
    expect(signalStagingBatch).not.toHaveBeenCalled();
    expect(res).toEqual({ terminal: true });
  });
});
