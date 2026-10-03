import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ prisma: {} as Record<string, Record<string, unknown>> }));
vi.mock("@/lib/db", () => db);
vi.mock("@/lib/gpterms", () => ({ closeAccount: vi.fn() }));
vi.mock("@/lib/vault/resolver", () => ({ getSecret: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { stackConfigured: false } }));

import { denialStillBinds, eraseSubject, normaliseCategories } from "@/lib/account-erasure";

const now = new Date("2026-10-04T12:00:00Z");
const denied = { status: "DENIED", allowResubmit: true, cooldownUntil: null, decidedAt: new Date("2026-06-03T10:00:00Z") };

describe("normaliseCategories", () => {
  it("adds applications to account, because deleting the user cascades to them", () => {
    expect(normaliseCategories(["account"])).toEqual(["account", "applications"]);
  });
  it("refuses an unknown category rather than erasing less than asked", () => {
    expect(() => normaliseCategories(["everything"])).toThrow(/unknown erasure categories/);
  });
});

describe("denialStillBinds", () => {
  it("keeps nothing for a denial whose cooldown has ended", () => {
    expect(denialStillBinds({ ...denied, cooldownUntil: new Date("2026-07-01T00:00:00Z") }, "DSR-1", now)).toBeNull();
  });
  it("keeps nothing for an application that was not denied", () => {
    expect(denialStillBinds({ ...denied, status: "APPROVED" }, "DSR-1", now)).toBeNull();
  });
  it("keeps a denial that forbids re-applying, naming the request and not the person", () => {
    const reason = denialStillBinds({ ...denied, allowResubmit: false }, "DSR-1", now);
    expect(reason).toMatch(/denied on 2026-06-03/);
    expect(reason).toMatch(/DSR-1/);
    expect(reason).toMatch(/not allowed/);
  });
  it("keeps a running cooldown with the date it ends", () => {
    const reason = denialStillBinds({ ...denied, cooldownUntil: new Date("2026-12-01T00:00:00Z") }, "DSR-1", now);
    expect(reason).toMatch(/allowed from 2026-12-01/);
  });
});

describe("eraseSubject, dry run", () => {
  const f = () => vi.fn();
  beforeEach(() => {
    db.prisma = {
      user: { findMany: f() },
      application: { findMany: f() },
      prCheck: { findMany: f() },
      claSignature: { count: f() },
      manualDecision: { count: f() },
      aiResult: { count: f() },
      auditEvent: { count: f() },
      notification: { count: f() },
      $transaction: f() as unknown as Record<string, unknown>,
    };
    const m = (model: string, fn: string) => db.prisma[model][fn] as ReturnType<typeof vi.fn>;
    m("user", "findMany").mockResolvedValue([{ id: "u1", email: "a@example.org", ghLogin: "Someone", ghId: 7, stackUserId: null }]);
    m("application", "findMany").mockResolvedValue([{ id: "app1", projectId: "p1", ...denied, allowResubmit: false }]);
    m("prCheck", "findMany").mockResolvedValue([{ id: "pr1" }]);
    m("claSignature", "count").mockResolvedValue(0);
    m("manualDecision", "count").mockResolvedValue(0);
    m("aiResult", "count").mockResolvedValue(0);
    m("auditEvent", "count").mockResolvedValue(2);
    m("notification", "count").mockResolvedValue(3);
  });

  it("counts, writes nothing, and lists the denial it would keep", async () => {
    const report = await eraseSubject(
      { ghLogin: "someone" },
      {
        categories: ["account", "prChecks", "aiResults", "auditEvents"],
        keepDenialRecords: true,
        requestRef: "DSR-1",
        execute: false,
        now,
      },
    );
    expect(report.executed).toBe(false);
    expect(report.erased).toEqual({ aiResults: 0, auditEvents: 2, prChecks: 1, applications: 1, notifications: 3, users: 1 });
    expect(report.denialRecords).toHaveLength(1);
    expect(report.denialRecords[0]).toMatchObject({ projectId: "p1", ghLogin: "someone", ghId: 7 });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a request reference that could carry personal data", async () => {
    await expect(
      eraseSubject({ ghLogin: "someone" }, { categories: ["prChecks"], keepDenialRecords: false, requestRef: "a@example.org", execute: false }),
    ).rejects.toThrow(/requestRef/);
  });
});
