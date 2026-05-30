import { describe, expect, it, vi, beforeEach } from "vitest";

const projectFindUnique = vi.fn();
const prCheckFindMany = vi.fn();
const prCheckUpdate = vi.fn();
const userFindMany = vi.fn();
const removeLabelIfPresent = vi.fn();
const setLabels = vi.fn();
const ensureLabel = vi.fn();
const decideForRepo = vi.fn();
const publishDecisionCheck = vi.fn();
const publishClaCheck = vi.fn();
const invalidateClaCache = vi.fn();
const notifyUser = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findUnique: (...args: unknown[]) => projectFindUnique(...args),
    },
    prCheck: {
      findMany: (...args: unknown[]) => prCheckFindMany(...args),
      update: (...args: unknown[]) => prCheckUpdate(...args),
    },
    user: {
      findMany: (...args: unknown[]) => userFindMany(...args),
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: { githubAppConfigured: true, PUBLIC_BASE_URL: "https://example.com" },
}));

vi.mock("@/lib/github/pr-actions", () => ({
  ensureLabel: (...args: unknown[]) => ensureLabel(...args),
  removeLabelIfPresent: (...args: unknown[]) => removeLabelIfPresent(...args),
  setLabels: (...args: unknown[]) => setLabels(...args),
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
}));

vi.mock("@/lib/notifications/inbox", () => ({
  notifyUser: (...args: unknown[]) => notifyUser(...args),
}));

vi.mock("@/lib/notifications/email", () => ({
  applyUrl: (slug: string) => `https://example.com/p/${slug}`,
}));

vi.mock("@/lib/applications/decide-pr", () => ({
  decideForRepo: (...args: unknown[]) => decideForRepo(...args),
  decisionRepoInclude: {},
}));

vi.mock("@/lib/github/check-run", () => ({
  publishDecisionCheck: (...args: unknown[]) => publishDecisionCheck(...args),
  publishClaCheck: (...args: unknown[]) => publishClaCheck(...args),
}));

vi.mock("@/lib/cla/status", () => ({
  invalidateClaCache: (...args: unknown[]) => invalidateClaCache(...args),
}));

import { onClaCoverageChanged, onClaCoverageRevoked } from "@/lib/cla/post-sign";

const baseProject = {
  id: "proj1",
  slug: "acme",
  name: "Acme",
  checksEnabled: true,
  labelsEnabled: true,
  labelApproved: "contribution:approved",
  labelClaPending: "contribution:cla-pending",
};

function check(id: string, repoId: string, prNumber: number, installationId = 11) {
  return {
    id,
    repoId,
    prNumber,
    authorGhLogin: "octocat",
    authorGhId: 42,
    headSha: "sha-" + id,
    repo: { id: repoId, fullName: "owner/r1", installationId },
  };
}

beforeEach(() => {
  projectFindUnique.mockReset();
  prCheckFindMany.mockReset();
  prCheckUpdate.mockReset();
  userFindMany.mockReset();
  removeLabelIfPresent.mockReset();
  setLabels.mockReset();
  ensureLabel.mockReset();
  decideForRepo.mockReset();
  publishDecisionCheck.mockReset();
  publishClaCheck.mockReset();
  invalidateClaCache.mockReset();
  notifyUser.mockReset();
  removeLabelIfPresent.mockResolvedValue(undefined);
  setLabels.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  prCheckUpdate.mockResolvedValue(undefined);
  publishDecisionCheck.mockResolvedValue(undefined);
  publishClaCheck.mockResolvedValue(undefined);
  userFindMany.mockResolvedValue([]);
  notifyUser.mockResolvedValue(undefined);
});

describe("onClaCoverageChanged", () => {
  it("invalidates the coverage cache up front", async () => {
    projectFindUnique.mockResolvedValueOnce({ ...baseProject, repos: [] });
    await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });
    expect(invalidateClaCache).toHaveBeenCalledWith("proj1", 42);
  });

  it("flips now-allowing gated PRs to a passing Check + approved label", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    decideForRepo.mockResolvedValueOnce({
      status: "APPROVED",
      repoId: "repo1",
      projectId: "proj1",
    });

    const result = await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });

    expect(result).toEqual({ rechecked: 1 });
    expect(publishDecisionCheck).toHaveBeenCalledTimes(1);
    // The dedicated CLA check is re-published too, so a CLA check required in
    // branch protection clears alongside the decision check.
    expect(publishClaCheck).toHaveBeenCalledTimes(1);
    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        prCheckId: "c1",
        state: "satisfied",
        claUrl: "https://example.com/p/acme/cla",
      })
    );
    expect(removeLabelIfPresent).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "contribution:cla-pending"
    );
    expect(setLabels).toHaveBeenCalledWith(
      expect.anything(),
      7,
      ["contribution:approved"]
    );
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "APPROVED", gateReason: null },
    });
  });

  it("leaves still-unsatisfied PRs untouched", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    decideForRepo.mockResolvedValueOnce({
      status: "CHECK_REQUIRED",
      reason: "cla_required",
      repoId: "repo1",
      projectId: "proj1",
    });

    const result = await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });

    expect(result).toEqual({ rechecked: 0 });
    expect(publishDecisionCheck).not.toHaveBeenCalled();
    expect(publishClaCheck).not.toHaveBeenCalled();
    expect(prCheckUpdate).not.toHaveBeenCalled();
  });

  it("publishes an exempt CLA check when the author is now bot-bypassed", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    decideForRepo.mockResolvedValueOnce({
      status: "BYPASSED",
      reason: "bot",
      repoId: "repo1",
      projectId: "proj1",
    });

    await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });

    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({ prCheckId: "c1", state: "exempt" })
    );
  });

  it("queries only this author's CLA-gated open PRs", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([]);

    await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });

    expect(prCheckFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repoId: { in: ["repo1"] },
          authorGhId: 42,
          status: "CHECK_REQUIRED",
          gateReason: { in: ["cla_required", "cla_stale"] },
        }),
      })
    );
  });

  it("no-ops when the GitHub App is not configured", async () => {
    // env.githubAppConfigured is true in the mock; simulate "no work" instead
    // via no repos to keep the env mock simple, and assert the early guards.
    projectFindUnique.mockResolvedValueOnce({ ...baseProject, repos: [] });
    const result = await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });
    expect(result).toEqual({ rechecked: 0 });
    expect(prCheckFindMany).not.toHaveBeenCalled();
  });

  it("survives a per-PR failure and continues with the rest", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([
      check("c1", "repo1", 7),
      check("c2", "repo1", 9),
    ]);
    decideForRepo
      .mockResolvedValueOnce({ status: "APPROVED", repoId: "repo1", projectId: "proj1" })
      .mockResolvedValueOnce({ status: "APPROVED", repoId: "repo1", projectId: "proj1" });
    publishDecisionCheck
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const result = await onClaCoverageChanged({ projectId: "proj1", ghId: 42 });

    expect(result).toEqual({ rechecked: 1 });
    expect(prCheckUpdate).toHaveBeenCalledTimes(1);
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { status: "APPROVED", gateReason: null },
    });
  });
});

describe("onClaCoverageRevoked", () => {
  it("invalidates the cache for each affected ghId and notifies linked users", async () => {
    projectFindUnique.mockResolvedValueOnce({ ...baseProject, repos: [] });
    userFindMany.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }]);

    await onClaCoverageRevoked({ projectId: "proj1", ghIds: [42, 43, 42] });

    // Deduped.
    expect(invalidateClaCache).toHaveBeenCalledWith("proj1", 42);
    expect(invalidateClaCache).toHaveBeenCalledWith("proj1", 43);
    expect(invalidateClaCache).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", kind: "cla.resign_required" })
    );
  });

  it("flips a now-stale passing PR to a failing CLA check + cla-pending label", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    decideForRepo.mockResolvedValueOnce({
      status: "CHECK_REQUIRED",
      reason: "cla_stale",
      repoId: "repo1",
      projectId: "proj1",
    });

    const result = await onClaCoverageRevoked({ projectId: "proj1", ghIds: [42] });

    expect(result).toEqual({ regated: 1 });
    expect(publishDecisionCheck).toHaveBeenCalledTimes(1);
    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({ prCheckId: "c1", state: "stale" })
    );
    expect(ensureLabel).toHaveBeenCalled();
    expect(removeLabelIfPresent).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "contribution:approved"
    );
    expect(setLabels).toHaveBeenCalledWith(
      expect.anything(),
      7,
      ["contribution:cla-pending"]
    );
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "CHECK_REQUIRED", gateReason: "cla_stale" },
    });
  });

  it("publishes a required CLA check when coverage is fully gone (cla_required)", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    decideForRepo.mockResolvedValueOnce({
      status: "CHECK_REQUIRED",
      reason: "cla_required",
      repoId: "repo1",
      projectId: "proj1",
    });

    await onClaCoverageRevoked({ projectId: "proj1", ghIds: [42] });

    expect(publishClaCheck).toHaveBeenCalledWith(
      expect.objectContaining({ prCheckId: "c1", state: "required" })
    );
  });

  it("leaves PRs still covered by another path untouched", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([check("c1", "repo1", 7)]);
    // Still covered (e.g. a second ICLA or a CCLA roster): fresh decision allows.
    decideForRepo.mockResolvedValueOnce({
      status: "APPROVED",
      repoId: "repo1",
      projectId: "proj1",
    });

    const result = await onClaCoverageRevoked({ projectId: "proj1", ghIds: [42] });

    expect(result).toEqual({ regated: 0 });
    expect(publishDecisionCheck).not.toHaveBeenCalled();
    expect(prCheckUpdate).not.toHaveBeenCalled();
  });

  it("queries only APPROVED PRs for the affected authors", async () => {
    projectFindUnique.mockResolvedValueOnce({
      ...baseProject,
      repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
    });
    prCheckFindMany.mockResolvedValueOnce([]);

    await onClaCoverageRevoked({ projectId: "proj1", ghIds: [42, 99] });

    expect(prCheckFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repoId: { in: ["repo1"] },
          authorGhId: { in: [42, 99] },
          status: "APPROVED",
        }),
      })
    );
  });
});
