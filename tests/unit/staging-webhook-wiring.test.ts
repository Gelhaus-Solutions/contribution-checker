import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const repoUpdate = vi.fn();
const prCheckFindUnique = vi.fn();
const retargetFindUnique = vi.fn();
const retargetUpsert = vi.fn();
const retargetDelete = vi.fn();

const setPullRequestBase = vi.fn();
const getBranchSha = vi.fn();
const installationHasContentsWrite = vi.fn();
const signalStagingBatch = vi.fn();
const decideForPR = vi.fn();
const publishDecisionCheck = vi.fn();
const publishClaCheck = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => repoFindUnique(...a),
      update: (...a: unknown[]) => repoUpdate(...a),
    },
    prCheck: { findUnique: (...a: unknown[]) => prCheckFindUnique(...a) },
    stagingRetarget: {
      findUnique: (...a: unknown[]) => retargetFindUnique(...a),
      upsert: (...a: unknown[]) => retargetUpsert(...a),
      delete: (...a: unknown[]) => retargetDelete(...a),
    },
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

vi.mock("@/lib/github/check-run", () => ({
  publishDecisionCheck: (...a: unknown[]) => publishDecisionCheck(...a),
  publishClaCheck: (...a: unknown[]) => publishClaCheck(...a),
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

/** An `unlabeled` event: the label is gone from `pull_request.labels`, and the
 * PR is back on the default branch after the revert moved it. */
function unlabeled(number: number, label: string) {
  const p = payload();
  return {
    ...p,
    action: "unlabeled",
    label: { name: label },
    pull_request: { ...p.pull_request, number, labels: [] },
  };
}

/** A `labeled` event on a PR already sitting on staging. */
function labeled(number: number, label: string) {
  const p = payload();
  return {
    ...p,
    action: "labeled",
    label: { name: label },
    pull_request: {
      ...p.pull_request,
      number,
      base: { ref: "staging", repo: { default_branch: "main" } },
      labels: [{ name: label }],
    },
  };
}

beforeEach(() => {
  for (const fn of [
    repoFindUnique,
    repoUpdate,
    prCheckFindUnique,
    retargetFindUnique,
    retargetUpsert,
    retargetDelete,
    setPullRequestBase,
    getBranchSha,
    installationHasContentsWrite,
    signalStagingBatch,
    decideForPR,
    publishDecisionCheck,
    publishClaCheck,
  ]) {
    fn.mockReset();
  }
  publishDecisionCheck.mockResolvedValue(undefined);
  publishClaCheck.mockResolvedValue(undefined);
  repoFindUnique.mockResolvedValue({ ...REPO });
  repoUpdate.mockResolvedValue({});
  prCheckFindUnique.mockResolvedValue(null);
  retargetFindUnique.mockResolvedValue(null);
  retargetUpsert.mockResolvedValue({});
  retargetDelete.mockResolvedValue({});
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

  it("ignores an edit that changed none of base, title or body", async () => {
    await handlePullRequestEvent(
      payload({ action: "edited", changes: {} }) as never,
    );
    expect(repoFindUnique).not.toHaveBeenCalled();
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });

  it("refreshes the batch when a MERGED PR on staging has its body edited", async () => {
    // The case this was actually reported for. Writing the `## QA` section
    // after the PR merged is the normal way it happens, and routing used to
    // drop every closed-PR event before it could say the PR was on staging, so
    // the edit reached nothing and the board kept showing "no testing notes".
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { body: { from: "old body" } },
        pull_request: {
          ...payload().pull_request,
          state: "closed",
          merged: true,
          base: { ref: "staging", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(signalStagingBatch).toHaveBeenCalled();
    expect(setPullRequestBase).not.toHaveBeenCalled();
  });

  it("does not refresh the batch for a closed PR that never touched staging", async () => {
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { body: { from: "old body" } },
        pull_request: {
          ...payload().pull_request,
          state: "closed",
          merged: true,
          base: { ref: "main", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(signalStagingBatch).not.toHaveBeenCalled();
  });

  it("refreshes the batch when a PR on staging has its body edited", async () => {
    // The body carries the author's own `## QA` section and the issues the PR
    // closes, and it is routinely filled in AFTER the PR merged. Without this
    // the QA record keeps the empty version until something unrelated happens
    // to touch the batch, which reads as the dashboard being broken.
    await handlePullRequestEvent(
      payload({
        action: "edited",
        changes: { body: { from: "old body" } },
        pull_request: {
          ...payload().pull_request,
          base: { ref: "staging", repo: { default_branch: "main" } },
        },
      }) as never,
    );
    expect(signalStagingBatch).toHaveBeenCalled();
    // A description says nothing about the contributor, so the gate stays out.
    expect(decideForPR).not.toHaveBeenCalled();
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

  // Skipping the gate must not skip the checks: the aggregate PR is the one PR
  // that has to merge into the default branch, so a required
  // `contribution-checker / decision` there would otherwise never be reported
  // and the release would sit blocked forever.
  it("still publishes both gate checks on the aggregate PR", async () => {
    repoFindUnique.mockResolvedValue({ ...REPO, stagingBatchPrNumber: 42 });
    await handlePullRequestEvent(payload() as never);
    expect(publishDecisionCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "abc",
        prCheckId: null,
        decision: { status: "APPROVED", bypassReason: "staging_batch" },
      }),
    );
    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "abc", state: "exempt" }),
    );
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

  it("records where a retargeted PR came from", async () => {
    await handlePullRequestEvent(prNumbered(45) as never);
    expect(retargetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          repoId: "repo1",
          prNumber: 45,
          fromBase: "main",
          toBase: "staging",
        }),
      }),
    );
  });

  /** A label added to a PR that is already on staging: the skip reason cannot
   * help there, so without the revert the label silently does nothing. */
  it("puts a PR it retargeted back on the default branch when the opt-out label arrives", async () => {
    retargetFindUnique.mockResolvedValue({ fromBase: "main" });
    const res = await handlePullRequestEvent(
      labeled(46, "staging:opt-out") as never,
    );
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      46,
      "main",
    );
    expect(retargetDelete).toHaveBeenCalled();
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "opt_out_reverted",
    });
    // The label routes; it says nothing about the contributor.
    expect(decideForPR).not.toHaveBeenCalled();
  });

  // gitroomhq/postiz-app#1993: the author opened the PR against staging
  // himself, so there was no retarget record, and requiring one meant the
  // maintainer's opt-out label did nothing at all. Only a user with write
  // access can label a PR, so their "keep this off staging" wins over the base
  // they are the ones overriding.
  it("moves a PR it never retargeted to the default branch on the label", async () => {
    retargetFindUnique.mockResolvedValue(null);
    const res = await handlePullRequestEvent(
      labeled(47, "staging:opt-out") as never,
    );
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      47,
      "main",
    );
    // Nothing to drop: the move was not undoing a row of ours.
    expect(retargetDelete).not.toHaveBeenCalled();
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "opt_out_rerouted",
    });
    // The label routes; it says nothing about the contributor.
    expect(decideForPR).not.toHaveBeenCalled();
  });

  // Undoing our own write survives the switch being turned off; forming a NEW
  // opinion about a base in a repo that has opted out of routing does not.
  it("does not move an unrecorded PR when retargeting is off", async () => {
    retargetFindUnique.mockResolvedValue(null);
    repoFindUnique.mockResolvedValue({
      ...REPO,
      project: { ...PROJECT, stagingRetargetEnabled: false },
    });
    const res = await handlePullRequestEvent(
      labeled(49, "staging:opt-out") as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "retarget_disabled",
    });
  });

  it("still reverts a PR it did retarget when retargeting is off", async () => {
    retargetFindUnique.mockResolvedValue({ fromBase: "main" });
    repoFindUnique.mockResolvedValue({
      ...REPO,
      project: { ...PROJECT, stagingRetargetEnabled: false },
    });
    const res = await handlePullRequestEvent(
      labeled(51, "staging:opt-out") as never,
    );
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      51,
      "main",
    );
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "opt_out_reverted",
    });
  });

  it("keeps the record when the revert is refused, so it can be retried", async () => {
    retargetFindUnique.mockResolvedValue({ fromBase: "main" });
    setPullRequestBase.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Validation Failed: {"message":"There are no new commits between ` +
            `base branch 'main' and head branch 'feature'"}`,
        ),
        { status: 422 },
      ),
    );
    const res = await handlePullRequestEvent(
      labeled(48, "staging:opt-out") as never,
    );
    expect(retargetDelete).not.toHaveBeenCalled();
    expect(res.staging).toEqual({
      retargeted: false,
      outcome: "revert_impossible",
    });
  });

  it("routes the PR again when the opt-out label is removed", async () => {
    const res = await handlePullRequestEvent(
      unlabeled(50, "staging:opt-out") as never,
    );
    expect(setPullRequestBase).toHaveBeenCalledWith(
      expect.anything(),
      50,
      "staging",
    );
    expect(res.staging).toEqual({ retargeted: true, outcome: "retargeted" });
    expect(decideForPR).not.toHaveBeenCalled();
  });

  // The bot removes its own evaluate label after every re-eval. Re-gating on
  // that echo would be an unbounded loop.
  it("ignores the removal of any other label, the evaluate label included", async () => {
    const res = await handlePullRequestEvent(
      unlabeled(51, "contribution:evaluate") as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
    expect(decideForPR).not.toHaveBeenCalled();
    expect(res.staging).toBeUndefined();
  });

  it("ignores a label that is neither the evaluate nor the opt-out label", async () => {
    const res = await handlePullRequestEvent(
      labeled(49, "needs-review") as never,
    );
    expect(setPullRequestBase).not.toHaveBeenCalled();
    expect(res.staging).toBeUndefined();
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
