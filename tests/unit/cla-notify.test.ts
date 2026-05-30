import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. notify.ts pulls in prisma, the notification helpers, coverage lookup,
// and the PR re-gate; stub them so the test exercises only the reminder
// guard/dedup logic and the sweep's dedupe + re-gate routing.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    notification: { findFirst: vi.fn() },
    application: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/notifications/inbox", () => ({ notifyUser: vi.fn() }));

vi.mock("@/lib/notifications/email", () => ({
  applyUrl: (slug: string) => `https://cc.test/p/${slug}`,
  emailUserById: vi.fn(),
}));

vi.mock("@/lib/cla/status", () => ({ getClaStatus: vi.fn() }));

vi.mock("@/lib/cla/post-sign", () => ({
  reapplyClaGateForApprovedAuthor: vi.fn(),
  notifyPendingApplicantsOnPrs: vi.fn(async () => ({ commented: 0 })),
}));

vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

import { prisma } from "@/lib/db";
import {
  notifyApplicantClaRequired,
  notifyPendingApplicant,
  sweepUnsignedApplicants,
} from "@/lib/cla/notify";
import { notifyUser } from "@/lib/notifications/inbox";
import { emailUserById } from "@/lib/notifications/email";
import { getClaStatus } from "@/lib/cla/status";
import {
  reapplyClaGateForApprovedAuthor,
  notifyPendingApplicantsOnPrs,
} from "@/lib/cla/post-sign";
import { recordAudit } from "@/lib/audit";

const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;

const projectRow: {
  id: string;
  slug: string;
  name: string;
  claEnabled: boolean;
  claRequired: boolean;
  currentIclaVersionId: string | null;
} = {
  id: "p1",
  slug: "proj",
  name: "Proj",
  claEnabled: true,
  claRequired: true,
  currentIclaVersionId: "v1",
};

function mockProject(over: Partial<typeof projectRow> = {}) {
  fn(prisma.project.findUnique).mockResolvedValue({ ...projectRow, ...over });
}

describe("notifyApplicantClaRequired", () => {
  beforeEach(() => {
    mockProject();
    fn(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      ghId: 42,
      ghLogin: "alice",
    });
    fn(getClaStatus).mockResolvedValue({
      satisfied: false,
      needsResign: false,
    });
    fn(prisma.notification.findFirst).mockResolvedValue(null);
  });

  it("sends in-app + email when uncovered and an ICLA version exists", async () => {
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(true);
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", kind: "cla.signature_required" }),
    );
    expect(emailUserById).toHaveBeenCalledTimes(1);
  });

  it("uses the resign kind when the signature is stale", async () => {
    fn(getClaStatus).mockResolvedValue({ satisfied: false, needsResign: true });
    await notifyApplicantClaRequired({ userId: "u1", projectId: "p1" });
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.resign_required" }),
    );
  });

  it("no-ops when the applicant is already covered", async () => {
    fn(getClaStatus).mockResolvedValue({ satisfied: true });
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(emailUserById).not.toHaveBeenCalled();
  });

  it("no-ops when there is no current ICLA version (nowhere to sign)", async () => {
    mockProject({ currentIclaVersionId: null });
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(getClaStatus).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("no-ops when the user has no GitHub identity", async () => {
    fn(prisma.user.findUnique).mockResolvedValue({
      id: "u1",
      ghId: null,
      ghLogin: null,
    });
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("no-ops when the project does not require a CLA", async () => {
    mockProject({ claRequired: false });
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("is idempotent: skips when an unread reminder already exists", async () => {
    fn(prisma.notification.findFirst).mockResolvedValue({ id: "n1" });
    const sent = await notifyApplicantClaRequired({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(emailUserById).not.toHaveBeenCalled();
  });
});

describe("notifyPendingApplicant", () => {
  beforeEach(() => {
    fn(prisma.project.findUnique).mockResolvedValue({
      id: "p1",
      slug: "proj",
      name: "Proj",
    });
    fn(prisma.user.findUnique).mockResolvedValue({ id: "u1" });
    fn(prisma.notification.findFirst).mockResolvedValue(null);
  });

  it("sends an awaiting-review notice in-app + email", async () => {
    const sent = await notifyPendingApplicant({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(true);
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        kind: "application.awaiting_review",
      }),
    );
    expect(emailUserById).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: skips when an unread awaiting-review notice exists", async () => {
    fn(prisma.notification.findFirst).mockResolvedValue({ id: "n9" });
    const sent = await notifyPendingApplicant({
      userId: "u1",
      projectId: "p1",
    });
    expect(sent).toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(emailUserById).not.toHaveBeenCalled();
  });
});

describe("sweepUnsignedApplicants", () => {
  it("dedupes by user (APPROVED beats SUBMITTED) and PR-re-gates only approved authors with a ghId", async () => {
    mockProject();
    fn(getClaStatus).mockResolvedValue({
      satisfied: false,
      needsResign: false,
    });
    fn(prisma.notification.findFirst).mockResolvedValue(null);
    fn(reapplyClaGateForApprovedAuthor).mockResolvedValue({ gated: 0 });
    fn(prisma.application.findMany).mockResolvedValue([
      { userId: "u1", status: "SUBMITTED", user: { ghId: 1 } },
      { userId: "u1", status: "APPROVED", user: { ghId: 1 } },
      { userId: "u2", status: "SUBMITTED", user: { ghId: 2 } },
      { userId: "u3", status: "APPROVED", user: { ghId: null } },
    ]);
    fn(prisma.user.findUnique).mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const map: Record<
          string,
          { id: string; ghId: number | null; ghLogin: string | null }
        > = {
          u1: { id: "u1", ghId: 1, ghLogin: "a" },
          u2: { id: "u2", ghId: 2, ghLogin: "b" },
          u3: { id: "u3", ghId: null, ghLogin: null },
        };
        return Promise.resolve(map[where.id] ?? null);
      },
    );

    const res = await sweepUnsignedApplicants({
      projectId: "p1",
      actorId: "admin",
    });

    // u1 + u2 notified; u3 skipped (no GitHub identity).
    expect(res).toEqual({ notified: 2, skipped: 1, total: 3 });
    // Only u1 is APPROVED with a ghId in the dedup map -> exactly one re-gate.
    expect(reapplyClaGateForApprovedAuthor).toHaveBeenCalledTimes(1);
    expect(reapplyClaGateForApprovedAuthor).toHaveBeenCalledWith({
      projectId: "p1",
      ghId: 1,
    });
    // u2 is the only SUBMITTED applicant (u1 deduped to APPROVED), so the
    // awaiting-review PR comment pass runs for its ghId only.
    expect(notifyPendingApplicantsOnPrs).toHaveBeenCalledWith({
      projectId: "p1",
      ghIds: [2],
    });
    // Audit brackets the run.
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.notify_unsigned_started" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.notify_unsigned_completed" }),
    );
  });
});
