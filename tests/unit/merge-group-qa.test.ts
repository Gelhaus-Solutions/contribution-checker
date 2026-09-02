import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const prCheckFindUnique = vi.fn();
const batchFindFirst = vi.fn();
const batchItemFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
    prCheck: { findUnique: (...a: unknown[]) => prCheckFindUnique(...a) },
    stagingBatch: { findFirst: (...a: unknown[]) => batchFindFirst(...a) },
    stagingBatchItem: {
      findMany: (...a: unknown[]) => batchItemFindMany(...a),
    },
  },
}));

const publishDecisionCheck = vi.fn();
const publishClaCheck = vi.fn();
const publishQaNotApplicableCheck = vi.fn();
const publishQaVerdictCheck = vi.fn();

vi.mock("@/lib/github/check-run", () => ({
  publishDecisionCheck: (...a: unknown[]) => publishDecisionCheck(...a),
  publishClaCheck: (...a: unknown[]) => publishClaCheck(...a),
  publishQaNotApplicableCheck: (...a: unknown[]) =>
    publishQaNotApplicableCheck(...a),
  publishQaVerdictCheck: (...a: unknown[]) => publishQaVerdictCheck(...a),
}));

const decideForRepo = vi.fn();

vi.mock("@/lib/applications/decide-pr", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/applications/decide-pr")
  >("@/lib/applications/decide-pr");
  return { ...actual, decideForRepo: (...a: unknown[]) => decideForRepo(...a) };
});

vi.mock("@/lib/temporal/start", () => ({
  signalStagingBatch: vi.fn(),
}));

import { handleMergeGroupEvent } from "@/lib/github/webhook";

/** CLA and DCO off: this file is about the QA check, not the gate layers. */
const PROJECT = {
  id: "proj1",
  slug: "postiz",
  name: "Postiz",
  checksEnabled: true,
  claEnabled: false,
  claRequired: false,
  dcoEnabled: false,
};

const STAGING_PROJECT = {
  id: "proj1",
  bypassHandles: "[]",
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: false,
  stagingDigestEnabled: false,
  stagingDigestSections: "[]",
  stagingQaEnabled: true,
  checksEnabled: true,
  qaCheckEnabled: true,
  qaFailedLabel: "qa:failed",
  qaStandingChecks: "[]",
  stagingBranch: "staging",
  labelStagingBatch: "staging:batch",
  labelStagingIgnore: "staging:ignore",
  labelStagingRepoint: "staging:repoint",
};

/** One fixture serves both reads of `repo`: the gate's `include` and the QA
 * publisher's `select`. Each destructures only what it asked for. */
function repoFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo1",
    projectId: "proj1",
    fullName: "postiz/postiz",
    installationId: 99,
    active: true,
    defaultBranch: "main",
    stagingBatchPrNumber: null as number | null,
    stagingRetargetEnabled: null,
    stagingBatchPrEnabled: null,
    stagingSyncEnabled: null,
    stagingDigestEnabled: null,
    stagingQaEnabled: null,
    stagingBranch: null,
    project: STAGING_PROJECT,
    ...overrides,
  };
}

function mergeGroup(base: string, prs: number[]) {
  const segments = prs.map((n) => `pr-${n}-abcdef`).join("/");
  return {
    action: "checks_requested",
    installation: { id: 99 },
    repository: { id: 1, full_name: "postiz/postiz" },
    merge_group: {
      head_sha: "mg-sha",
      head_ref: `refs/heads/gh-readonly-queue/${base}/${segments}`,
      base_ref: `refs/heads/${base}`,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoFindUnique.mockResolvedValue(repoFixture());
  projectFindUnique.mockResolvedValue(PROJECT);
  prCheckFindUnique.mockResolvedValue({
    authorGhLogin: "octocat",
    authorGhId: 7,
  });
  batchFindFirst.mockResolvedValue({ id: "batch1" });
  batchItemFindMany.mockResolvedValue([]);
  decideForRepo.mockResolvedValue({ status: "APPROVED", bypassReason: null });
  for (const fn of [
    publishDecisionCheck,
    publishClaCheck,
    publishQaNotApplicableCheck,
    publishQaVerdictCheck,
  ]) {
    fn.mockResolvedValue(undefined);
  }
});

/**
 * The queue requires every protected-branch check to report against its own
 * throwaway head commit. The QA check otherwise only ever lands on the
 * aggregate PR's head, so without an answer here the queue on that branch
 * never drains.
 */
describe("QA check on a merge group", () => {
  it("reports 'does not apply' for work queued into staging", async () => {
    await handleMergeGroupEvent(mergeGroup("staging", [42]) as never);
    expect(publishQaVerdictCheck).not.toHaveBeenCalled();
    expect(publishQaNotApplicableCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "mg-sha",
        reason: { kind: "merge_into_staging", stagingBranch: "staging" },
      }),
    );
  });

  it("reports 'does not apply' for a group carrying no batch", async () => {
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(publishQaNotApplicableCheck).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "no_batch" } }),
    );
  });

  // The case the whole thing exists for: a fully verified release enters the
  // queue and its verdict has to be republished on the queue's commit, or it
  // sits there forever on a check that already passed somewhere else.
  it("republishes the batch verdict when the release PR is queued", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({ stagingBatchPrNumber: 500 }),
    );
    batchItemFindMany.mockResolvedValue([
      {
        key: "pr:101",
        kind: "PR",
        prNumber: 101,
        title: "Add a thing",
        authorLogin: "octocat",
        qaStatus: "QA_PASSED",
        qaNotes: null,
        droppedAt: null,
      },
    ]);
    await handleMergeGroupEvent(mergeGroup("main", [500]) as never);

    expect(publishQaNotApplicableCheck).not.toHaveBeenCalled();
    expect(publishQaVerdictCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "mg-sha",
        items: [expect.objectContaining({ prNumber: 101 })],
      }),
    );
  });

  it("reports nothing to verify when the release PR has no open batch", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({ stagingBatchPrNumber: 500 }),
    );
    batchFindFirst.mockResolvedValue(null);
    await handleMergeGroupEvent(mergeGroup("main", [500]) as never);

    expect(batchItemFindMany).not.toHaveBeenCalled();
    expect(publishQaVerdictCheck).toHaveBeenCalledWith(
      expect.objectContaining({ items: [] }),
    );
  });

  // A repo that records no QA publishes this check nowhere, so there is
  // nothing here for a queue to be waiting on.
  it("publishes no QA check when the repo does not run QA", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({
        project: { ...STAGING_PROJECT, stagingQaEnabled: false },
      }),
    );
    await handleMergeGroupEvent(mergeGroup("staging", [42]) as never);
    expect(publishQaNotApplicableCheck).not.toHaveBeenCalled();
    expect(publishQaVerdictCheck).not.toHaveBeenCalled();
  });
});

/**
 * The aggregate PR never goes through the gate, so evaluating it in the queue
 * would find no application, call it PENDING and hold the release on a check
 * the pull_request path deliberately publishes as a pass.
 */
describe("the aggregate PR in a merge group", () => {
  it("publishes the gate checks as a staging batch without gating it", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({ stagingBatchPrNumber: 500 }),
    );
    await handleMergeGroupEvent(mergeGroup("main", [500]) as never);

    expect(decideForRepo).not.toHaveBeenCalled();
    expect(publishDecisionCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "mg-sha",
        prCheckId: null,
        decision: { status: "APPROVED", bypassReason: "staging_batch" },
      }),
    );
    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "mg-sha", state: "exempt" }),
    );
  });

  it("still gates the real contributions batched alongside it", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({ stagingBatchPrNumber: 500 }),
    );
    decideForRepo.mockResolvedValue({ status: "PENDING", reason: "none" });
    await handleMergeGroupEvent(mergeGroup("main", [500, 42]) as never);

    expect(decideForRepo).toHaveBeenCalledTimes(1);
    expect(publishDecisionCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ status: "PENDING" }),
      }),
    );
  });

  it("still returns without publishing when nothing in the group is gateable", async () => {
    decideForRepo.mockResolvedValue({ status: "IGNORED", reason: "inactive" });
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(publishDecisionCheck).not.toHaveBeenCalled();
    // The QA answer is independent of the gate and is published regardless.
    expect(publishQaNotApplicableCheck).toHaveBeenCalled();
  });
});
