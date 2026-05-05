import { describe, expect, it, vi, beforeEach } from "vitest";

const applicationReviewFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    applicationReview: {
      findMany: (...args: unknown[]) => applicationReviewFindMany(...args),
    },
  },
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

import {
  countApprovingReviewers,
  ApprovalGateError,
} from "@/lib/applications/decide";
import { visibilityForReviewState } from "@/lib/applications/schema";

beforeEach(() => {
  applicationReviewFindMany.mockReset();
});

describe("visibilityForReviewState", () => {
  it("APPROVED forces INTERNAL regardless of chosen", () => {
    expect(visibilityForReviewState("APPROVED", "APPLICANT")).toBe("INTERNAL");
    expect(visibilityForReviewState("APPROVED", undefined)).toBe("INTERNAL");
  });
  it("CHANGES_REQUESTED forces APPLICANT regardless of chosen", () => {
    expect(visibilityForReviewState("CHANGES_REQUESTED", "INTERNAL")).toBe(
      "APPLICANT",
    );
    expect(visibilityForReviewState("CHANGES_REQUESTED", undefined)).toBe(
      "APPLICANT",
    );
  });
  it("COMMENTED defers to chosen, defaults INTERNAL", () => {
    expect(visibilityForReviewState("COMMENTED", "APPLICANT")).toBe("APPLICANT");
    expect(visibilityForReviewState("COMMENTED", "INTERNAL")).toBe("INTERNAL");
    expect(visibilityForReviewState("COMMENTED", undefined)).toBe("INTERNAL");
  });
});

describe("countApprovingReviewers", () => {
  it("counts distinct other-author APPROVED reviews", async () => {
    applicationReviewFindMany.mockResolvedValue([
      { authorId: "u1" },
      { authorId: "u2" },
      { authorId: "u1" }, // duplicate — should collapse
    ]);
    const n = await countApprovingReviewers({
      applicationId: "app1",
      excludeUserId: "actor",
    });
    expect(n).toBe(2);
    expect(applicationReviewFindMany).toHaveBeenCalledWith({
      where: {
        applicationId: "app1",
        state: "APPROVED",
        deletedAt: null,
        authorId: { not: "actor" },
      },
      select: { authorId: true },
    });
  });

  it("returns 0 when only the actor has approved", async () => {
    // The actor is excluded by the where-clause; this simulates that result.
    applicationReviewFindMany.mockResolvedValue([]);
    const n = await countApprovingReviewers({
      applicationId: "app1",
      excludeUserId: "actor",
    });
    expect(n).toBe(0);
  });

  it("excludes soft-dismissed reviews via where-clause", async () => {
    // Confirm via the where-clause shape — the count itself comes from the
    // mocked return. This guards against accidental removal of the
    // deletedAt filter, which would let dismissed reviews count toward the
    // gate.
    applicationReviewFindMany.mockResolvedValue([{ authorId: "u1" }]);
    await countApprovingReviewers({
      applicationId: "app1",
      excludeUserId: "actor",
    });
    const callArg = applicationReviewFindMany.mock.calls[0]?.[0] as {
      where: { deletedAt: null };
    };
    expect(callArg.where.deletedAt).toBe(null);
  });
});

describe("ApprovalGateError", () => {
  it("carries required and have", () => {
    const e = new ApprovalGateError(2, 0);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApprovalGateError");
    expect(e.required).toBe(2);
    expect(e.have).toBe(0);
  });
});
