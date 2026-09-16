import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const prCheckFindUnique = vi.fn();
const prCheckFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
    prCheck: {
      findUnique: (...a: unknown[]) => prCheckFindUnique(...a),
      findMany: (...a: unknown[]) => prCheckFindMany(...a),
    },
    stagingBatch: { findFirst: vi.fn(async () => null) },
    stagingBatchItem: { findMany: vi.fn(async () => []) },
  },
}));

const publishDecisionCheck = vi.fn();
const publishClaCheck = vi.fn();
const publishQaNotApplicableCheck = vi.fn();
const publishQaVerdictCheck = vi.fn();
const publishStandaloneGuardCheck = vi.fn();

vi.mock("@/lib/github/check-run", () => ({
  publishDecisionCheck: (...a: unknown[]) => publishDecisionCheck(...a),
  publishClaCheck: (...a: unknown[]) => publishClaCheck(...a),
  publishQaNotApplicableCheck: (...a: unknown[]) =>
    publishQaNotApplicableCheck(...a),
  publishQaVerdictCheck: (...a: unknown[]) => publishQaVerdictCheck(...a),
  publishStandaloneGuardCheck: (...a: unknown[]) =>
    publishStandaloneGuardCheck(...a),
}));

const decideForRepo = vi.fn();

vi.mock("@/lib/applications/decide-pr", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/applications/decide-pr")
  >("@/lib/applications/decide-pr");
  return { ...actual, decideForRepo: (...a: unknown[]) => decideForRepo(...a) };
});

vi.mock("@/lib/temporal/start", () => ({ signalStagingBatch: vi.fn() }));

import { handleMergeGroupEvent } from "@/lib/github/webhook";

/** CLA, DCO and QA off: this file is about the guard check. */
const PROJECT = {
  id: "proj1",
  slug: "acme",
  name: "Acme",
  checksEnabled: true,
  claEnabled: false,
  claRequired: false,
  dcoEnabled: false,
};

const GUARDED_PROJECT = {
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
  labelStagingBatch: "staging:batch",
  labelStagingIgnore: "staging:ignore",
  labelStagingRepoint: "staging:repoint",
  // The guard's own config, on and guarding migrations.
  guardEnabled: true,
  guardRules: '["migrations"]',
  guardGlobs: "[]",
  guardApprovers: '["alice"]',
  guardUnlockMode: "either",
  labelGuardUnlock: "guard:approved",
  labelGuardBlocked: "guard:blocked",
};

/** One fixture serves every read of `repo`; each destructures what it asked for. */
function repoFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo1",
    projectId: "proj1",
    fullName: "acme/app",
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
    project: GUARDED_PROJECT,
    ...overrides,
  };
}

function mergeGroup(base: string, prs: number[]) {
  const segments = prs.map((n) => `pr-${n}-abcdef`).join("/");
  return {
    action: "checks_requested",
    installation: { id: 99 },
    repository: { id: 1, full_name: "acme/app" },
    merge_group: {
      head_sha: "mg-sha",
      head_ref: `refs/heads/gh-readonly-queue/${base}/${segments}`,
      base_ref: `refs/heads/${base}`,
    },
  };
}

const guardPayload = () => publishStandaloneGuardCheck.mock.calls[0][0].payload;

beforeEach(() => {
  vi.clearAllMocks();
  repoFindUnique.mockResolvedValue(repoFixture());
  projectFindUnique.mockResolvedValue(PROJECT);
  prCheckFindUnique.mockResolvedValue({
    authorGhLogin: "octocat",
    authorGhId: 7,
  });
  prCheckFindMany.mockResolvedValue([]);
  decideForRepo.mockResolvedValue({ status: "APPROVED", bypassReason: null });
  for (const fn of [
    publishDecisionCheck,
    publishClaCheck,
    publishQaNotApplicableCheck,
    publishQaVerdictCheck,
    publishStandaloneGuardCheck,
  ]) {
    fn.mockResolvedValue(undefined);
  }
});

describe("the guard check on a merge group", () => {
  // The queue requires every protected-branch check to report against its own
  // throwaway commit. Without an answer here the queue never drains.
  it("publishes against the merge-group head SHA", async () => {
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(publishStandaloneGuardCheck).toHaveBeenCalledTimes(1);
    expect(publishStandaloneGuardCheck.mock.calls[0][0]).toMatchObject({
      headSha: "mg-sha",
      repoFullName: "acme/app",
    });
  });

  // A queue on the staging branch holds every contribution on a question about
  // the default branch that does not apply to them.
  it("passes as does-not-apply when the group targets another branch", async () => {
    await handleMergeGroupEvent(mergeGroup("staging", [42]) as never);
    const p = guardPayload();
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("Does not apply");
    // No point reading rows for a branch the guard has no say over.
    expect(prCheckFindMany).not.toHaveBeenCalled();
  });

  it("passes when no member is blocked", async () => {
    prCheckFindMany.mockResolvedValue([
      { prNumber: 42, guardLabelApplied: false },
    ]);
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(guardPayload().conclusion).toBe("success");
  });

  it("fails and names the member holding the queue up", async () => {
    prCheckFindMany.mockResolvedValue([
      { prNumber: 42, guardLabelApplied: true },
      { prNumber: 43, guardLabelApplied: false },
    ]);
    await handleMergeGroupEvent(mergeGroup("main", [42, 43]) as never);
    const p = guardPayload();
    expect(p.conclusion).toBe("failure");
    expect(p.summary).toContain("- #42");
    expect(p.summary).not.toContain("- #43");
  });

  // Most-blocking-wins: one unsigned member gates the whole group, because the
  // queue merges all of them or none.
  it("fails the whole group for one blocked member", async () => {
    prCheckFindMany.mockResolvedValue([
      { prNumber: 1, guardLabelApplied: false },
      { prNumber: 2, guardLabelApplied: false },
      { prNumber: 3, guardLabelApplied: true },
    ]);
    await handleMergeGroupEvent(mergeGroup("main", [1, 2, 3]) as never);
    expect(guardPayload().conclusion).toBe("failure");
  });

  // The release PR is guarded on its own head like any other PR into main, and
  // that check, not this one, speaks for it.
  it("excludes the aggregate staging PR from the group's verdict", async () => {
    repoFindUnique.mockResolvedValue(repoFixture({ stagingBatchPrNumber: 99 }));
    prCheckFindMany.mockResolvedValue([
      { prNumber: 99, guardLabelApplied: true },
    ]);
    await handleMergeGroupEvent(mergeGroup("main", [99]) as never);
    expect(guardPayload().conclusion).toBe("success");
  });

  // A PR with no row has never been through the guard, so it holds no unlock,
  // but neither has it been found blocked: the PR path is what decides that.
  it("treats a member with no tracked row as not blocking", async () => {
    prCheckFindMany.mockResolvedValue([]);
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(guardPayload().conclusion).toBe("success");
  });

  it("publishes nothing when the project does not guard anything", async () => {
    repoFindUnique.mockResolvedValue(
      repoFixture({ project: { ...GUARDED_PROJECT, guardEnabled: false } }),
    );
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(publishStandaloneGuardCheck).not.toHaveBeenCalled();
  });

  // The guard is a question about files, not about the contributor, so a group
  // with nothing gateable in it still gets an answer.
  it("is published independently of the gate", async () => {
    decideForRepo.mockResolvedValue({ status: "IGNORED" });
    await handleMergeGroupEvent(mergeGroup("main", [42]) as never);
    expect(publishStandaloneGuardCheck).toHaveBeenCalledTimes(1);
  });
});
