import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const repoUpdate = vi.fn();
const prCheckFindUnique = vi.fn();
const retargetFindUnique = vi.fn();

const runGuardForPr = vi.fn();
const decideForPR = vi.fn();
const publishDecisionCheck = vi.fn();
const publishClaCheck = vi.fn();
const publishQaNotApplicableCheck = vi.fn();
const publishStandaloneGuardCheck = vi.fn();
const signalStagingBatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => repoFindUnique(...a),
      update: (...a: unknown[]) => repoUpdate(...a),
    },
    prCheck: { findUnique: (...a: unknown[]) => prCheckFindUnique(...a) },
    stagingRetarget: {
      findUnique: (...a: unknown[]) => retargetFindUnique(...a),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/guard/run", () => ({
  runGuardForPr: (...a: unknown[]) => runGuardForPr(...a),
}));

vi.mock("@/lib/github/pr-actions", () => ({
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
  setPullRequestBase: vi.fn(async () => ({ ok: true })),
  getBranchSha: vi.fn(async () => null),
  installationHasContentsWrite: vi.fn(async () => false),
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

vi.mock("@/lib/github/check-run", () => ({
  publishDecisionCheck: (...a: unknown[]) => publishDecisionCheck(...a),
  publishClaCheck: (...a: unknown[]) => publishClaCheck(...a),
  publishQaNotApplicableCheck: (...a: unknown[]) =>
    publishQaNotApplicableCheck(...a),
  publishStandaloneGuardCheck: (...a: unknown[]) =>
    publishStandaloneGuardCheck(...a),
}));

vi.mock("@/lib/applications/decide-pr", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/applications/decide-pr")
  >("@/lib/applications/decide-pr");
  return { ...actual, decideForPR: (...a: unknown[]) => decideForPR(...a) };
});

import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
} from "@/lib/github/webhook";

const PROJECT = {
  id: "proj1",
  bypassHandles: "[]",
  stagingRetargetEnabled: false,
  stagingBatchPrEnabled: false,
  stagingSyncEnabled: false,
  stagingDigestEnabled: false,
  stagingDigestSections: "[]",
  stagingQaEnabled: false,
  checksEnabled: true,
  qaCheckEnabled: false,
  qaFailedLabel: "qa:failed",
  qaStandingChecks: "[]",
  stagingBranch: "staging",
  labelEvaluate: "contribution:evaluate",
  labelStagingBatch: "staging:batch",
  labelStagingIgnore: "staging:ignore",
  labelStagingRepoint: "staging:repoint",
  labelGuardUnlock: "guard:approved",
};

const REPO = {
  id: "repo1",
  fullName: "acme/app",
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
      full_name: "acme/app",
      name: "app",
      owner: { login: "acme" },
      default_branch: "main",
    },
    sender: { login: "alice" },
    pull_request: {
      number: 42,
      node_id: "n42",
      state: "open",
      user: { login: "octocat", id: 7, type: "User" },
      head: { sha: "abc", ref: "feature", repo: { full_name: "fork/app" } },
      base: { ref: "main", repo: { default_branch: "main" } },
      labels: [] as Array<{ name: string }>,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoFindUnique.mockResolvedValue(REPO);
  prCheckFindUnique.mockResolvedValue(null);
  retargetFindUnique.mockResolvedValue(null);
  // IGNORED stops convergePr before the decision pipeline, so these tests are
  // about the wiring rather than the gate.
  decideForPR.mockResolvedValue({ status: "IGNORED" });
  runGuardForPr.mockResolvedValue({ verdict: null });
  // The publishers are `.catch`-chained at every call site, so they have to
  // hand back a promise rather than undefined.
  publishDecisionCheck.mockResolvedValue(undefined);
  publishClaCheck.mockResolvedValue(undefined);
  publishQaNotApplicableCheck.mockResolvedValue(undefined);
  publishStandaloneGuardCheck.mockResolvedValue(undefined);
});

describe("the guard on the pull_request path", () => {
  it("runs on a PR opened against the default branch", async () => {
    await handlePullRequestEvent(payload() as never);
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      ghRepoId: 1,
      prNumber: 42,
      headSha: "abc",
      baseRef: "main",
      labelJustAppliedBy: null,
      labelJustRemoved: false,
    });
  });

  it("runs on a push to the PR", async () => {
    await handlePullRequestEvent(payload({ action: "synchronize" }) as never);
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
  });

  // The guard reads the file list and nothing else, so a retitle cannot change
  // its answer and must not cost a GitHub call.
  it("does not run on a title-only edit", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { title: { from: "old" } },
      }) as never,
    );
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

  it("does not run on a body-only edit", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { body: { from: "old" } },
      }) as never,
    );
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

  // A base change does change the answer: off the default branch the guard has
  // no say and has to republish as a pass rather than leave a red check.
  it("runs on a base change", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { base: { ref: { from: "main" } } },
      }) as never,
    );
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
  });

  it("does not run for a label it does not recognize", async () => {
    await handlePullRequestEvent(
      payload({
        action: "labeled",
        label: { name: "good first issue" },
      }) as never,
    );
    expect(runGuardForPr).not.toHaveBeenCalled();
  });
});

describe("the unlock label", () => {
  it("carries the sender, which is the only moment trust is knowable", async () => {
    await handlePullRequestEvent(
      payload({
        action: "labeled",
        label: { name: "guard:approved" },
        sender: { login: "alice" },
      }) as never,
    );
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      labelJustAppliedBy: "alice",
      labelJustRemoved: false,
    });
  });

  it("reports its removal so a label unlock can be cleared", async () => {
    await handlePullRequestEvent(
      payload({
        action: "unlabeled",
        label: { name: "guard:approved" },
      }) as never,
    );
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      labelJustRemoved: true,
      labelJustAppliedBy: null,
    });
  });

  // A label only a maintainer can set says nothing about the contributor, so it
  // routes and guards but never re-runs the gate.
  it("never reaches the decision pipeline", async () => {
    await handlePullRequestEvent(
      payload({
        action: "labeled",
        label: { name: "guard:approved" },
      }) as never,
    );
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
    expect(decideForPR).not.toHaveBeenCalled();
  });
});

describe("the aggregate staging PR", () => {
  // It is exempt from the contributor gate because it has no application, but
  // it is the one PR that merges every migration in a batch into main.
  it("skips the gate and is still guarded", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      stagingBatchPrNumber: 42,
      project: { ...PROJECT, stagingBatchPrEnabled: true },
    });
    await handlePullRequestEvent(
      payload({
        pull_request: {
          ...payload().pull_request,
          head: { sha: "abc", ref: "staging", repo: { full_name: "acme/app" } },
          base: { ref: "main", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(publishDecisionCheck).toHaveBeenCalledTimes(1);
    expect(decideForPR).not.toHaveBeenCalled();
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
  });
});

describe("handlePullRequestReviewEvent", () => {
  it.each(["submitted", "dismissed", "edited"])(
    "runs the guard on %s",
    async (action) => {
      await handlePullRequestReviewEvent(payload({ action }) as never);
      expect(runGuardForPr).toHaveBeenCalledTimes(1);
      expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
        prNumber: 42,
        baseRef: "main",
      });
    },
  );

  it("ignores every other action", async () => {
    await handlePullRequestReviewEvent(payload({ action: "deleted" }) as never);
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

  // A review says nothing about whether the author has an application, so
  // re-running the gate would be a full pipeline for no new decision.
  it("does not re-run the gate", async () => {
    await handlePullRequestReviewEvent(
      payload({ action: "submitted" }) as never,
    );
    expect(decideForPR).not.toHaveBeenCalled();
    expect(publishDecisionCheck).not.toHaveBeenCalled();
  });
});
