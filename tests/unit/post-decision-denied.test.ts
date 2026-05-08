import { describe, expect, it, vi, beforeEach } from "vitest";

const applicationFindUnique = vi.fn();
const prCheckFindMany = vi.fn();
const prCheckUpdate = vi.fn();
const commentOnPr = vi.fn();
const removeLabelIfPresent = vi.fn();
const setLabels = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    application: {
      findUnique: (...args: unknown[]) => applicationFindUnique(...args),
    },
    prCheck: {
      findMany: (...args: unknown[]) => prCheckFindMany(...args),
      update: (...args: unknown[]) => prCheckUpdate(...args),
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    githubAppConfigured: true,
    PUBLIC_BASE_URL: "https://example.com",
  },
}));

vi.mock("@/lib/github/pr-actions", () => ({
  commentOnPr: (...args: unknown[]) => commentOnPr(...args),
  removeLabelIfPresent: (...args: unknown[]) => removeLabelIfPresent(...args),
  setLabels: (...args: unknown[]) => setLabels(...args),
  closePullRequest: vi.fn(),
  reopenPullRequest: vi.fn(),
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
}));

vi.mock("@/lib/notifications/email", () => ({
  applyUrl: (slug: string) => `https://example.com/p/${slug}`,
}));

import { onApplicationDenied } from "@/lib/github/post-decision";

const baseProject = {
  id: "proj1",
  slug: "acme",
  name: "Acme",
  labelsEnabled: true,
  labelPending: "contribution:pending",
  labelApproved: "contribution:approved",
  labelDenied: "contribution:denied",
};

beforeEach(() => {
  applicationFindUnique.mockReset();
  prCheckFindMany.mockReset();
  prCheckUpdate.mockReset();
  commentOnPr.mockReset();
  removeLabelIfPresent.mockReset();
  setLabels.mockReset();
  // Default mocks return resolved promises so `.catch(...)` chains work.
  commentOnPr.mockResolvedValue(undefined);
  removeLabelIfPresent.mockResolvedValue(undefined);
  setLabels.mockResolvedValue(undefined);
  prCheckUpdate.mockResolvedValue(undefined);
});

describe("onApplicationDenied", () => {
  it("comments and relabels each PrCheck the bot closed as PENDING", async () => {
    applicationFindUnique.mockResolvedValueOnce({
      id: "app1",
      status: "DENIED",
      reason: "spam",
      cooldownUntil: null,
      user: { ghId: 42, ghLogin: "octocat" },
      project: {
        ...baseProject,
        repos: [
          { id: "repo1", fullName: "owner/r1", installationId: 11 },
          { id: "repo2", fullName: "owner/r2", installationId: 22 },
        ],
      },
    });
    prCheckFindMany.mockResolvedValueOnce([
      {
        id: "c1",
        repoId: "repo1",
        prNumber: 7,
        repo: { id: "repo1", fullName: "owner/r1", installationId: 11 },
      },
      {
        id: "c2",
        repoId: "repo2",
        prNumber: 9,
        repo: { id: "repo2", fullName: "owner/r2", installationId: 22 },
      },
    ]);

    const result = await onApplicationDenied({ applicationId: "app1" });

    expect(result).toEqual({ updated: 2 });

    // Comment posted on each PR with the denied message body.
    expect(commentOnPr).toHaveBeenCalledTimes(2);
    const [, , firstBody] = commentOnPr.mock.calls[0];
    expect(firstBody).toContain("@octocat");
    expect(firstBody).toContain("**Acme**");
    expect(firstBody).toContain("spam");

    // Pending and approved labels are stripped, denied label applied.
    expect(removeLabelIfPresent).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "contribution:pending"
    );
    expect(removeLabelIfPresent).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "contribution:approved"
    );
    expect(setLabels).toHaveBeenCalledWith(
      expect.anything(),
      7,
      ["contribution:denied"]
    );

    // PrCheck rows updated to DENIED.
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "DENIED" },
    });
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { status: "DENIED" },
    });
  });

  it("queries only PrChecks the bot closed as PENDING for this user", async () => {
    applicationFindUnique.mockResolvedValueOnce({
      id: "app1",
      status: "DENIED",
      reason: null,
      cooldownUntil: null,
      user: { ghId: 42, ghLogin: "octocat" },
      project: {
        ...baseProject,
        repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
      },
    });
    prCheckFindMany.mockResolvedValueOnce([]);

    await onApplicationDenied({ applicationId: "app1" });

    expect(prCheckFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repoId: { in: ["repo1"] },
          authorGhId: 42,
          status: "PENDING",
          closedByApp: true,
        }),
      })
    );
  });

  it("no-ops when the application is not in DENIED status", async () => {
    applicationFindUnique.mockResolvedValueOnce({
      id: "app1",
      status: "SUBMITTED",
      reason: null,
      cooldownUntil: null,
      user: { ghId: 42, ghLogin: "octocat" },
      project: { ...baseProject, repos: [] },
    });

    const result = await onApplicationDenied({ applicationId: "app1" });

    expect(result).toEqual({ updated: 0 });
    expect(prCheckFindMany).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it("skips relabel work when project labels are disabled", async () => {
    applicationFindUnique.mockResolvedValueOnce({
      id: "app1",
      status: "DENIED",
      reason: "no",
      cooldownUntil: null,
      user: { ghId: 42, ghLogin: "octocat" },
      project: {
        ...baseProject,
        labelsEnabled: false,
        repos: [{ id: "repo1", fullName: "owner/r1", installationId: 11 }],
      },
    });
    prCheckFindMany.mockResolvedValueOnce([
      {
        id: "c1",
        repoId: "repo1",
        prNumber: 7,
        repo: { id: "repo1", fullName: "owner/r1", installationId: 11 },
      },
    ]);

    const result = await onApplicationDenied({ applicationId: "app1" });

    expect(result).toEqual({ updated: 1 });
    expect(commentOnPr).toHaveBeenCalledTimes(1);
    expect(setLabels).not.toHaveBeenCalled();
    expect(removeLabelIfPresent).not.toHaveBeenCalled();
  });

  it("survives a per-PR failure and continues with the rest", async () => {
    applicationFindUnique.mockResolvedValueOnce({
      id: "app1",
      status: "DENIED",
      reason: null,
      cooldownUntil: null,
      user: { ghId: 42, ghLogin: "octocat" },
      project: {
        ...baseProject,
        repos: [
          { id: "repo1", fullName: "owner/r1", installationId: 11 },
          { id: "repo2", fullName: "owner/r2", installationId: 22 },
        ],
      },
    });
    prCheckFindMany.mockResolvedValueOnce([
      {
        id: "c1",
        repoId: "repo1",
        prNumber: 7,
        repo: { id: "repo1", fullName: "owner/r1", installationId: 11 },
      },
      {
        id: "c2",
        repoId: "repo2",
        prNumber: 9,
        repo: { id: "repo2", fullName: "owner/r2", installationId: 22 },
      },
    ]);
    commentOnPr
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(undefined);

    const result = await onApplicationDenied({ applicationId: "app1" });

    expect(result).toEqual({ updated: 1 });
    expect(prCheckUpdate).toHaveBeenCalledTimes(1);
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { status: "DENIED" },
    });
  });
});
