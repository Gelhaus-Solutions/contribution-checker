import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const prCheckFindUnique = vi.fn();
const listPullRequestFiles = vi.fn();
const listPullRequestReviews = vi.fn();
const publishGuardCheck = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    prCheck: {
      findUnique: (...a: unknown[]) => prCheckFindUnique(...a),
      update: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/applications/decide-pr", () => ({
  matchesAnyPattern: (login: string, patterns: string[]) =>
    patterns.includes(login),
}));
vi.mock("@/lib/github/pr-actions", () => ({
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
  listPullRequestFiles: (...a: unknown[]) => listPullRequestFiles(...a),
  listPullRequestReviews: (...a: unknown[]) => listPullRequestReviews(...a),
  addLabel: vi.fn(async () => undefined),
  ensureLabel: vi.fn(async () => undefined),
  removeLabelIfPresent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/github/check-run", () => ({
  publishGuardCheck: (...a: unknown[]) => publishGuardCheck(...a),
}));

import { runGuardForPr, resetGuardFileCacheForTests } from "@/lib/guard/run";

const PROJECT = {
  id: "p1",
  checksEnabled: true,
  guardEnabled: true,
  guardRules: "[]",
  guardGlobs: JSON.stringify(["migrations/**"]),
  guardApprovers: JSON.stringify(["alice"]),
  guardUnlockMode: "either",
  labelGuardUnlock: "guard:approved",
  labelGuardBlocked: "guard:blocked",
};

const BASE_ARGS = {
  ghRepoId: 1,
  repoFullName: "acme/app",
  installationId: 9,
  prNumber: 42,
  headSha: "abc",
  baseRef: "main",
};

const SETTLED = {
  id: "c1",
  guardUnlockSource: null,
  guardUnlockBy: null,
  guardApprovedFiles: "{}",
  guardLabelApplied: false,
  guardCheckSha: "abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetGuardFileCacheForTests();
  repoFindUnique.mockResolvedValue({
    id: "r1",
    active: true,
    defaultBranch: "main",
    project: PROJECT,
  });
  prCheckFindUnique.mockResolvedValue(SETTLED);
  listPullRequestFiles.mockResolvedValue({
    files: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, sha: "s1" }],
    truncated: false,
  });
  listPullRequestReviews.mockResolvedValue([]);
  publishGuardCheck.mockResolvedValue(undefined);
});

describe("guard request cost", () => {
  it("answers a diff-neutral event on a settled PR with no GitHub call", async () => {
    const res = await runGuardForPr({ ...BASE_ARGS, diffUnchanged: true });
    expect(res.verdict).toBeNull();
    expect(listPullRequestFiles).not.toHaveBeenCalled();
    expect(listPullRequestReviews).not.toHaveBeenCalled();
    expect(publishGuardCheck).not.toHaveBeenCalled();
  });

  it("still evaluates when the diff may have changed", async () => {
    await runGuardForPr({ ...BASE_ARGS, diffUnchanged: false });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
    expect(publishGuardCheck).toHaveBeenCalledTimes(1);
  });

  it("evaluates when the guard has not yet published at this head", async () => {
    prCheckFindUnique.mockResolvedValue({ ...SETTLED, guardCheckSha: "old" });
    await runGuardForPr({ ...BASE_ARGS, diffUnchanged: true });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
  });

  it("evaluates when the PR is blocked, so a new approval can clear it", async () => {
    prCheckFindUnique.mockResolvedValue({ ...SETTLED, guardLabelApplied: true });
    await runGuardForPr({ ...BASE_ARGS, diffUnchanged: true });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
  });

  it("evaluates when an unlock is held, so a dismissal can take it away", async () => {
    prCheckFindUnique.mockResolvedValue({
      ...SETTLED,
      guardUnlockSource: "review",
      guardUnlockBy: "alice",
    });
    await runGuardForPr({ ...BASE_ARGS, diffUnchanged: true });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
  });

  it("never skips the unlock label event", async () => {
    await runGuardForPr({
      ...BASE_ARGS,
      diffUnchanged: true,
      labelJustAppliedBy: "alice",
    });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
  });

  it("reads the file list once per head SHA", async () => {
    await runGuardForPr({ ...BASE_ARGS });
    await runGuardForPr({ ...BASE_ARGS });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(1);
    await runGuardForPr({ ...BASE_ARGS, headSha: "def" });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(2);
  });

  it("does not cache a PR that is gone", async () => {
    listPullRequestFiles.mockResolvedValue(null);
    await runGuardForPr({ ...BASE_ARGS });
    await runGuardForPr({ ...BASE_ARGS });
    expect(listPullRequestFiles).toHaveBeenCalledTimes(2);
  });
});
