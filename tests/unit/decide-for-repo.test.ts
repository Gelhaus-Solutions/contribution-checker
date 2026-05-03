import { describe, expect, it, vi, beforeEach } from "vitest";

const manualDecisionFindUnique = vi.fn();
const manualDecisionUpdate = vi.fn();
const userFindUnique = vi.fn();
const applicationFindFirst = vi.fn();
const isCollaborator = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    manualDecision: {
      findUnique: (...args: unknown[]) => manualDecisionFindUnique(...args),
      update: (...args: unknown[]) => manualDecisionUpdate(...args),
    },
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    application: { findFirst: (...args: unknown[]) => applicationFindFirst(...args) },
  },
}));

vi.mock("@/lib/github/collaborators", () => ({
  isCollaborator: (...args: unknown[]) => isCollaborator(...args),
}));

import { decideForRepo, type RepoForDecision } from "@/lib/applications/decide-pr";

function makeRepo(overrides: Partial<RepoForDecision> = {}): RepoForDecision {
  return {
    id: "repo1",
    projectId: "proj1",
    ghRepoId: 123,
    fullName: "octo/repo",
    installationId: null,
    requireOwnApproval: false,
    active: true,
    createdAt: new Date(),
    project: {
      id: "proj1",
      bypassHandles: '["*[bot]"]',
      bypassCollabs: true,
      checkerEnabled: true,
    },
    ...overrides,
  } as RepoForDecision;
}

beforeEach(() => {
  manualDecisionFindUnique.mockReset();
  manualDecisionUpdate.mockReset();
  userFindUnique.mockReset();
  applicationFindFirst.mockReset();
  isCollaborator.mockReset();
});

describe("decideForRepo", () => {
  it("returns APPROVED with bypassReason=checker_disabled when project's checker is off", async () => {
    const decision = await decideForRepo({
      repo: makeRepo({
        project: {
          id: "proj1",
          bypassHandles: '["*[bot]"]',
          bypassCollabs: true,
          checkerEnabled: false,
        },
      }),
      prAuthorGhLogin: "stranger",
      prAuthorGhId: 99,
    });
    expect(decision.status).toBe("APPROVED");
    if (decision.status === "APPROVED") {
      expect(decision.bypassReason).toBe("checker_disabled");
    }
    expect(manualDecisionFindUnique).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("returns IGNORED when the repo is inactive", async () => {
    const decision = await decideForRepo({
      repo: makeRepo({ active: false }),
      prAuthorGhLogin: "octocat",
      prAuthorGhId: 1,
    });
    expect(decision.status).toBe("IGNORED");
  });

  it("manual APPROVED wins over everything else", async () => {
    manualDecisionFindUnique.mockResolvedValue({
      id: "m1",
      status: "APPROVED",
      ghId: 1,
    });
    const decision = await decideForRepo({
      repo: makeRepo(),
      prAuthorGhLogin: "octocat",
      prAuthorGhId: 1,
    });
    expect(decision.status).toBe("APPROVED");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("manual DENIED returns DENIED with no cooldown", async () => {
    manualDecisionFindUnique.mockResolvedValue({
      id: "m1",
      status: "DENIED",
      ghId: 1,
      reason: "spam",
    });
    const decision = await decideForRepo({
      repo: makeRepo(),
      prAuthorGhLogin: "octocat",
      prAuthorGhId: 1,
    });
    expect(decision.status).toBe("DENIED");
    if (decision.status === "DENIED") {
      expect(decision.reason).toBe("spam");
      expect(decision.cooldownUntil).toBeNull();
    }
  });

  it("bypasses bot logins via the glob list", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    const decision = await decideForRepo({
      repo: makeRepo(),
      prAuthorGhLogin: "dependabot[bot]",
      prAuthorGhId: 99,
    });
    expect(decision.status).toBe("BYPASSED");
    if (decision.status === "BYPASSED") {
      expect(decision.reason).toBe("bot");
    }
  });

  it("isCollaboratorHint short-circuits without an Octokit call when installationId is null", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
      isCollaboratorHint: true,
    });
    expect(decision.status).toBe("BYPASSED");
    if (decision.status === "BYPASSED") {
      expect(decision.reason).toBe("collaborator");
    }
    expect(isCollaborator).not.toHaveBeenCalled();
  });

  it("isCollaboratorHint is ignored when bypassCollabs is off", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const decision = await decideForRepo({
      repo: makeRepo({
        project: {
          id: "proj1",
          bypassHandles: "[]",
          bypassCollabs: false,
          checkerEnabled: true,
        },
      }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
      isCollaboratorHint: true,
    });
    expect(decision.status).toBe("PENDING");
  });

  it("Octokit collaborator path runs only when installationId is set", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    isCollaborator.mockResolvedValue(true);
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: 555 }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("BYPASSED");
    expect(isCollaborator).toHaveBeenCalledOnce();
  });

  it("returns PENDING (no-application) when no User row exists", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "newbie",
      prAuthorGhId: 42,
    });
    expect(decision.status).toBe("PENDING");
    if (decision.status === "PENDING") {
      expect(decision.reason).toBe("no-application");
    }
  });

  it("returns PENDING (no-application) when a user exists but has never applied", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    applicationFindFirst.mockResolvedValue(null);
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("PENDING");
    if (decision.status === "PENDING") {
      expect(decision.reason).toBe("no-application");
    }
  });

  it("returns PENDING (submitted) when the latest application is awaiting review", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    applicationFindFirst.mockResolvedValue({
      status: "SUBMITTED",
      decidedAt: null,
      updatedAt: new Date(),
      reason: null,
      allowResubmit: true,
      cooldownUntil: null,
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("PENDING");
    if (decision.status === "PENDING") {
      expect(decision.reason).toBe("submitted");
    }
  });

  it("returns DENIED with no cooldown when allowResubmit is false", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    applicationFindFirst.mockResolvedValue({
      status: "DENIED",
      decidedAt: new Date(),
      updatedAt: new Date(),
      reason: "policy violation",
      allowResubmit: false,
      cooldownUntil: null,
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("DENIED");
    if (decision.status === "DENIED") {
      expect(decision.reason).toBe("policy violation");
      expect(decision.cooldownUntil).toBeNull();
    }
  });

  it("returns PENDING (cooldown-elapsed) when allowResubmit + cooldownUntil is null", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    applicationFindFirst.mockResolvedValue({
      status: "DENIED",
      decidedAt: new Date(),
      updatedAt: new Date(),
      reason: "borderline",
      allowResubmit: true,
      cooldownUntil: null,
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("PENDING");
    if (decision.status === "PENDING") {
      expect(decision.reason).toBe("cooldown-elapsed");
    }
  });

  it("returns APPROVED when the latest application is approved", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    applicationFindFirst.mockResolvedValue({
      status: "APPROVED",
      decidedAt: new Date(),
      updatedAt: new Date(),
      reason: null,
      allowResubmit: true,
      cooldownUntil: null,
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("APPROVED");
  });

  it("treats DENIED past the snapshotted cooldown as PENDING", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    const longAgo = new Date(Date.now() - 30 * 86400_000);
    applicationFindFirst.mockResolvedValue({
      status: "DENIED",
      decidedAt: longAgo,
      updatedAt: longAgo,
      reason: "spam",
      allowResubmit: true,
      cooldownUntil: new Date(Date.now() - 23 * 86400_000),
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("PENDING");
    if (decision.status === "PENDING") {
      expect(decision.reason).toBe("cooldown-elapsed");
    }
  });

  it("returns DENIED with cooldownUntil when still within cooldown", async () => {
    manualDecisionFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "u1" });
    const cooldownUntil = new Date(Date.now() + 6 * 86400_000);
    applicationFindFirst.mockResolvedValue({
      status: "DENIED",
      decidedAt: new Date(Date.now() - 1 * 86400_000),
      updatedAt: new Date(),
      reason: "spam",
      allowResubmit: true,
      cooldownUntil,
    });
    const decision = await decideForRepo({
      repo: makeRepo({ installationId: null }),
      prAuthorGhLogin: "alice",
      prAuthorGhId: 2,
    });
    expect(decision.status).toBe("DENIED");
    if (decision.status === "DENIED") {
      expect(decision.cooldownUntil?.getTime()).toBe(cooldownUntil.getTime());
    }
  });
});
