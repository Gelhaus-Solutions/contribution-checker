import { describe, expect, it, vi, beforeEach } from "vitest";

const applicationFindUnique = vi.fn();
const applicationUpdate = vi.fn();
const userFindUnique = vi.fn();
const manualFindUnique = vi.fn();
const appealCreate = vi.fn();
const appealFindUnique = vi.fn();
const appealUpdate = vi.fn();

const recordAudit = vi.fn();
const notifyUser = vi.fn();
const notifyProjectReviewers = vi.fn();
const sendEmail = vi.fn();
const enqueueProjectWebhook = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    application: {
      findUnique: (...a: unknown[]) => applicationFindUnique(...a),
      findFirst: vi.fn(),
      update: (...a: unknown[]) => applicationUpdate(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    manualDecision: { findUnique: (...a: unknown[]) => manualFindUnique(...a) },
    applicationAppeal: {
      create: (...a: unknown[]) => appealCreate(...a),
      findUnique: (...a: unknown[]) => appealFindUnique(...a),
      update: (...a: unknown[]) => appealUpdate(...a),
    },
  },
}));

vi.mock("@sentry/nextjs", () => ({ metrics: { count: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));
vi.mock("@/lib/notifications/inbox", () => ({
  notifyUser: (...a: unknown[]) => notifyUser(...a),
  notifyProjectReviewers: (...a: unknown[]) => notifyProjectReviewers(...a),
}));
vi.mock("@/lib/notifications/email", () => ({
  applyUrl: () => "http://example/apply",
  dashboardUrl: (p: string) => `http://example${p}`,
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
vi.mock("@/lib/notifications/webhooks", () => ({
  enqueueProjectWebhook: (...a: unknown[]) => enqueueProjectWebhook(...a),
}));
vi.mock("@/lib/cla/status", () => ({ isClaSatisfied: vi.fn() }));

import { submitAppeal } from "@/lib/applications/lifecycle";
import { resolveAppeal } from "@/lib/applications/decide";

// A minimal text form field so buildAnswersSchema accepts {}.
const FORM_SCHEMA = JSON.stringify([]);

function mockDeniedApp(overrides: {
  allowAppeals?: boolean;
  status?: string;
  appeal?: { id: string } | null;
  userId?: string;
} = {}) {
  applicationFindUnique.mockResolvedValueOnce({
    id: "app1",
    userId: overrides.userId ?? "user1",
    projectId: "proj1",
    status: overrides.status ?? "DENIED",
    project: {
      id: "proj1",
      slug: "acme",
      name: "Acme",
      formSchema: FORM_SCHEMA,
      allowAppeals: overrides.allowAppeals ?? true,
    },
    appeal: overrides.appeal === undefined ? null : overrides.appeal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  manualFindUnique.mockResolvedValue(null);
  userFindUnique.mockResolvedValue({ ghLogin: "octocat", email: "u@example.com" });
});

describe("submitAppeal guards", () => {
  it("rejects when the project disables appeals", async () => {
    mockDeniedApp({ allowAppeals: false });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "please reconsider",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not enabled") });
    expect(appealCreate).not.toHaveBeenCalled();
  });

  it("rejects when the application is not DENIED", async () => {
    mockDeniedApp({ status: "SUBMITTED" });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "hi",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("denied application") });
  });

  it("rejects a second appeal (one per application)", async () => {
    mockDeniedApp({ appeal: { id: "appeal0" } });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "again",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("already appealed") });
  });

  it("rejects a manually blocked (manual DENIED) user", async () => {
    mockDeniedApp();
    manualFindUnique.mockResolvedValueOnce({ status: "DENIED" });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "let me in",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not eligible") });
    expect(appealCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    mockDeniedApp();
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "   ",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("required") });
  });

  it("rejects an application that is not the user's own", async () => {
    mockDeniedApp({ userId: "other" });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "mine",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not your application") });
  });

  it("creates a PENDING appeal and audits on success", async () => {
    mockDeniedApp();
    appealCreate.mockResolvedValueOnce({ id: "appeal1" });
    const r = await submitAppeal({
      userId: "user1",
      applicationId: "app1",
      message: "  please reconsider  ",
      rawAnswers: {},
    });
    expect(r).toEqual({ ok: true, appealId: "appeal1" });
    expect(appealCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: "app1",
          projectId: "proj1",
          status: "PENDING",
          message: "please reconsider",
        }),
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "application.appeal_submitted" }),
    );
  });
});

describe("resolveAppeal", () => {
  function mockPendingAppeal(status = "PENDING", appStatus = "DENIED") {
    appealFindUnique.mockResolvedValueOnce({
      id: "appeal1",
      status,
      answers: JSON.stringify({ a: "revised" }),
      application: {
        id: "app1",
        userId: "user1",
        projectId: "proj1",
        status: appStatus,
        project: { id: "proj1", name: "Acme", slug: "acme" },
        user: { ghLogin: "octocat" },
      },
    });
    appealUpdate.mockResolvedValue({ id: "appeal1" });
  }

  it("throws when the appeal is already resolved", async () => {
    mockPendingAppeal("REJECTED");
    await expect(
      resolveAppeal({
        applicationId: "app1",
        resolution: "REJECT",
        resolvedById: "rev1",
      }),
    ).rejects.toThrow(/already resolved/);
  });

  it("REJECT marks the appeal rejected, notifies + emails the applicant", async () => {
    mockPendingAppeal();
    await resolveAppeal({
      applicationId: "app1",
      resolution: "REJECT",
      resolvedById: "rev1",
      note: "no",
    });
    expect(appealUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED", resolvedById: "rev1" }),
      }),
    );
    expect(notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "application.appeal_rejected" }),
    );
    expect(sendEmail).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "application.appeal_resolved" }),
    );
    expect(enqueueProjectWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ event: "application.appeal_resolved" }),
    );
    // No PR-reopen / approval side effects on reject.
    expect(applicationUpdate).not.toHaveBeenCalled();
  });
});
