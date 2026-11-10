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
const removeLabelIfPresent = vi.fn();
const octokitRequest = vi.fn();

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
  removeLabelIfPresent: (...a: unknown[]) => removeLabelIfPresent(...a),
  isRateLimitError: () => false,
  setLabels: vi.fn(),
  commentOnPr: vi.fn(),
  prHasCommentContaining: vi.fn(async () => false),
}));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: async () => ({
    request: (...a: unknown[]) => octokitRequest(...a),
  }),
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
  reGatePr,
} from "@/lib/github/webhook";
import { GmintRefusal } from "@/lib/github/gmint-tokens";

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

  // Neither can move the head or the base, so the guard is told it may answer
  // from what it already holds. A push and an open genuinely can.
  it("says the diff is unchanged on ready_for_review, but not on a push", async () => {
    await handlePullRequestEvent(
      payload({ action: "ready_for_review" }) as never,
    );
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      diffUnchanged: true,
    });
    runGuardForPr.mockClear();
    await handlePullRequestEvent(payload({ action: "synchronize" }) as never);
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      diffUnchanged: false,
    });
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

  // The gate takes the evaluate label off after a re-evaluation, and this PR
  // never reaches the gate: the label stayed on the release PR.
  it("loses the evaluate label that asked for a re-evaluation", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      stagingBatchPrNumber: 42,
      project: { ...PROJECT, stagingBatchPrEnabled: true },
    });
    await handlePullRequestEvent(
      payload({
        action: "labeled",
        label: { name: "contribution:evaluate" },
        pull_request: {
          ...payload().pull_request,
          head: { sha: "abc", ref: "staging", repo: { full_name: "acme/app" } },
          base: { ref: "main", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(removeLabelIfPresent).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app" }),
      42,
      "contribution:evaluate",
    );
    expect(decideForPR).not.toHaveBeenCalled();
  });
});

// A re-gate is how a re-evaluation, a changed guard rule and the catching up
// after an outage reach a PR that has no event of its own coming. It ran routing
// and the gate alone, so a guard or QA check that was never published stayed
// missing however often the PR was re-evaluated.
describe("a re-gate", () => {
  const fetched = (overrides: Record<string, unknown> = {}) => ({
    data: { ...payload().pull_request, ...overrides },
  });

  beforeEach(() => {
    repoFindUnique.mockResolvedValue({ ...REPO, projectId: "proj1" });
    octokitRequest.mockResolvedValue(fetched());
  });

  it("runs the guard on an open PR, against its head and base", async () => {
    await reGatePr({ ghRepoId: 1, prNumber: 42 });
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
    expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
      ghRepoId: 1,
      repoFullName: "acme/app",
      installationId: 99,
      prNumber: 42,
      headSha: "abc",
      baseRef: "main",
      labelJustAppliedBy: null,
      labelJustRemoved: false,
      // A changed guard rule is applied by a re-gate, so the guard may not
      // answer from what it holds.
      diffUnchanged: false,
    });
    expect(decideForPR).toHaveBeenCalledTimes(1);
  });

  it("passes the QA check for an ignored PR on the default branch", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      projectId: "proj1",
      project: {
        ...PROJECT,
        stagingRetargetEnabled: true,
        stagingBatchPrEnabled: true,
        stagingQaEnabled: true,
        qaCheckEnabled: true,
      },
    });
    octokitRequest.mockResolvedValue(
      fetched({ labels: [{ name: "staging:ignore" }] }),
    );
    await reGatePr({ ghRepoId: 1, prNumber: 42 });
    expect(publishQaNotApplicableCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "abc",
        reason: { kind: "label", label: "staging:ignore" },
      }),
    );
  });

  // A closed PR is re-gated so that one the bot closed can reopen, which is the
  // gate's business. No check is published on a PR nobody can merge.
  it("leaves the guard and the QA check of a closed PR alone", async () => {
    octokitRequest.mockResolvedValue(fetched({ state: "closed" }));
    await reGatePr({ ghRepoId: 1, prNumber: 42 });
    expect(runGuardForPr).not.toHaveBeenCalled();
    expect(publishQaNotApplicableCheck).not.toHaveBeenCalled();
    expect(decideForPR).toHaveBeenCalledTimes(1);
  });

  it("publishes the aggregate PR's checks and guards it, without the gate", async () => {
    repoFindUnique.mockResolvedValue({
      ...REPO,
      projectId: "proj1",
      stagingBatchPrNumber: 42,
      project: { ...PROJECT, stagingBatchPrEnabled: true },
    });
    octokitRequest.mockResolvedValue(
      fetched({
        head: { sha: "abc", ref: "staging", repo: { full_name: "acme/app" } },
      }),
    );
    await reGatePr({ ghRepoId: 1, prNumber: 42 });
    expect(publishDecisionCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "abc",
        decision: { status: "APPROVED", bypassReason: "staging_batch" },
      }),
    );
    expect(runGuardForPr).toHaveBeenCalledTimes(1);
    expect(decideForPR).not.toHaveBeenCalled();
  });

  // Logged and reported done, this is how a PR re-gated while the token broker
  // was down was never heard of again. Thrown, the activity tries again.
  it("throws a read that may work later", async () => {
    octokitRequest.mockRejectedValue(
      new GmintRefusal("transport", 503, true, "GMint is not answering"),
    );
    await expect(reGatePr({ ghRepoId: 1, prNumber: 42 })).rejects.toThrow(
      "GMint is not answering",
    );
    octokitRequest.mockRejectedValue(
      Object.assign(new Error("Bad Gateway"), { status: 502 }),
    );
    await expect(reGatePr({ ghRepoId: 1, prNumber: 42 })).rejects.toThrow(
      "Bad Gateway",
    );
    octokitRequest.mockRejectedValue(
      Object.assign(new Error("budget"), { status: 429 }),
    );
    await expect(reGatePr({ ghRepoId: 1, prNumber: 42 })).rejects.toThrow(
      "budget",
    );
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

  it("ends quietly for a PR that is gone, or a token GMint refuses for good", async () => {
    octokitRequest.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await expect(
      reGatePr({ ghRepoId: 1, prNumber: 42 }),
    ).resolves.toBeUndefined();
    octokitRequest.mockRejectedValue(
      new GmintRefusal("denied", 403, false, "GMint does not allow this"),
    );
    await expect(
      reGatePr({ ghRepoId: 1, prNumber: 42 }),
    ).resolves.toBeUndefined();
    expect(runGuardForPr).not.toHaveBeenCalled();
    expect(decideForPR).not.toHaveBeenCalled();
  });
});

describe("handlePullRequestReviewEvent", () => {
  it.each(["submitted", "dismissed"])(
    "runs the guard on %s",
    async (action) => {
      await handlePullRequestReviewEvent(payload({ action }) as never);
      expect(runGuardForPr).toHaveBeenCalledTimes(1);
      expect(runGuardForPr.mock.calls[0][0]).toMatchObject({
        prNumber: 42,
        baseRef: "main",
        diffUnchanged: true,
      });
    },
  );

  it.each(["approved", "changes_requested"])(
    "runs the guard on a submitted %s review",
    async (state) => {
      await handlePullRequestReviewEvent(
        payload({ action: "submitted", review: { state } }) as never,
      );
      expect(runGuardForPr).toHaveBeenCalledTimes(1);
    },
  );

  // The guard only reads APPROVED, CHANGES_REQUESTED and DISMISSED, so a
  // comment review (every review bot, every inline-comment batch) and an edited
  // review body cannot change the verdict and must cost nothing.
  it("ignores a submitted comment review", async () => {
    await handlePullRequestReviewEvent(
      payload({ action: "submitted", review: { state: "commented" } }) as never,
    );
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

  it("ignores an edited review", async () => {
    await handlePullRequestReviewEvent(payload({ action: "edited" }) as never);
    expect(runGuardForPr).not.toHaveBeenCalled();
  });

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
