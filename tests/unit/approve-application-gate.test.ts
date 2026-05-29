import { describe, expect, it, vi, beforeEach } from "vitest";

const applicationFindUnique = vi.fn();
const applicationUpdate = vi.fn();
const userFindUnique = vi.fn();
const isClaSatisfied = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    application: {
      findUnique: (...args: unknown[]) => applicationFindUnique(...args),
      update: (...args: unknown[]) => applicationUpdate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/cla/status", () => ({
  isClaSatisfied: (...args: unknown[]) => isClaSatisfied(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  metrics: { count: vi.fn() },
}));

vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/notifications/inbox", () => ({
  notifyUser: vi.fn(),
  notifyProjectReviewers: vi.fn(),
}));
vi.mock("@/lib/notifications/email", () => ({
  applyUrl: () => "http://example/apply",
  dashboardUrl: (p: string) => `http://example${p}`,
  sendEmail: vi.fn(),
}));
vi.mock("@/lib/notifications/webhooks", () => ({
  enqueueProjectWebhook: vi.fn(),
}));

import { approveApplication, ClaGateError } from "@/lib/applications/decide";

type ProjectOverrides = {
  claEnabled?: boolean;
  claRequired?: boolean;
  requireApprovalCount?: number;
};
type UserOverrides = { ghId?: number | null; ghLogin?: string | null };

function mockApp(project: ProjectOverrides = {}, user: UserOverrides = {}) {
  applicationFindUnique.mockResolvedValueOnce({
    id: "app1",
    projectId: "proj1",
    userId: "user1",
    project: {
      id: "proj1",
      name: "Acme",
      slug: "acme",
      requireApprovalCount: project.requireApprovalCount ?? 0,
      claEnabled: project.claEnabled ?? false,
      claRequired: project.claRequired ?? false,
    },
    user: {
      ghId: user.ghId === undefined ? 42 : user.ghId,
      ghLogin: user.ghLogin === undefined ? "octocat" : user.ghLogin,
    },
  });
}

beforeEach(() => {
  applicationFindUnique.mockReset();
  applicationUpdate.mockReset();
  userFindUnique.mockReset();
  isClaSatisfied.mockReset();
  applicationUpdate.mockResolvedValue({ id: "app1", status: "APPROVED" });
  // emailUser() reads the applicant's email; null => no email sent.
  userFindUnique.mockResolvedValue({ email: null });
});

describe("ClaGateError", () => {
  it("is an Error with a stable name and message", () => {
    const e = new ClaGateError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ClaGateError");
    expect(e.message).toContain("cla_gate_blocked");
  });
});

describe("approveApplication CLA gate", () => {
  it("throws ClaGateError when the CLA is required but unsatisfied", async () => {
    mockApp({ claEnabled: true, claRequired: true });
    isClaSatisfied.mockResolvedValueOnce(false);

    await expect(
      approveApplication({ applicationId: "app1", decidedById: "reviewer1" }),
    ).rejects.toBeInstanceOf(ClaGateError);
    expect(applicationUpdate).not.toHaveBeenCalled();
    expect(isClaSatisfied).toHaveBeenCalledWith({
      projectId: "proj1",
      ghId: 42,
      ghLogin: "octocat",
    });
  });

  it("approves when the CLA is satisfied (icla/ccla/waiver)", async () => {
    mockApp({ claEnabled: true, claRequired: true });
    isClaSatisfied.mockResolvedValueOnce(true);

    const result = await approveApplication({
      applicationId: "app1",
      decidedById: "reviewer1",
    });

    expect(result.status).toBe("APPROVED");
    expect(applicationUpdate).toHaveBeenCalledOnce();
  });

  it("does not gate when the CLA is record-only (claRequired=false)", async () => {
    mockApp({ claEnabled: true, claRequired: false });

    const result = await approveApplication({
      applicationId: "app1",
      decidedById: "reviewer1",
    });

    expect(result.status).toBe("APPROVED");
    // The gate block is skipped entirely — coverage is never probed.
    expect(isClaSatisfied).not.toHaveBeenCalled();
  });

  it("does not gate when the CLA is disabled", async () => {
    mockApp({ claEnabled: false, claRequired: true });

    const result = await approveApplication({
      applicationId: "app1",
      decidedById: "reviewer1",
    });

    expect(result.status).toBe("APPROVED");
    expect(isClaSatisfied).not.toHaveBeenCalled();
  });

  it("throws ClaGateError for an unlinked applicant without probing coverage", async () => {
    // No ghId/ghLogin (never completed GitHub OAuth): can't satisfy the CLA.
    mockApp({ claEnabled: true, claRequired: true }, { ghId: null, ghLogin: null });

    await expect(
      approveApplication({ applicationId: "app1", decidedById: "reviewer1" }),
    ).rejects.toBeInstanceOf(ClaGateError);
    expect(isClaSatisfied).not.toHaveBeenCalled();
    expect(applicationUpdate).not.toHaveBeenCalled();
  });
});
