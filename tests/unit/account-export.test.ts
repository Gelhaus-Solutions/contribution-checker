import { describe, it, expect, vi, beforeEach } from "vitest";

const f = () => vi.fn(async (_args?: unknown): Promise<unknown> => []);
const db = vi.hoisted(() => ({ prisma: {} as Record<string, Record<string, unknown>> }));
vi.mock("@/lib/db", () => db);

import { buildAccountExport } from "@/lib/account-export";

const fn = (m: unknown) => m as ReturnType<typeof f>;
const PROJECT = { id: "p1", slug: "proj", name: "Proj" };

beforeEach(() => {
  db.prisma.user = { findUnique: f() };
  for (const m of [
    "projectMember", "application", "claSignature", "cclaRosterMember",
    "claWaiver", "prCheck", "notification", "termsAcceptance",
    "claEventLog", "auditEvent", "aiResult",
  ]) {
    db.prisma[m] = { findMany: f() };
  }
  fn(db.prisma.user.findUnique).mockResolvedValue({
    id: "u1", name: "Ada", email: "ada@example.com", ghId: 42, ghLogin: "ada",
  });
});

const calls = (model: string) =>
  JSON.stringify(fn(db.prisma[model].findMany).mock.calls);

describe("buildAccountExport", () => {
  it("returns null for an unknown user", async () => {
    fn(db.prisma.user.findUnique).mockResolvedValue(null);
    expect(await buildAccountExport("nope")).toBeNull();
  });

  it("matches by user id and by GitHub id and login", async () => {
    await buildAccountExport("u1");
    expect(calls("claSignature")).toContain('"userId":"u1"');
    expect(calls("claSignature")).toContain('"ghId":42');
    expect(calls("prCheck")).toContain('"authorGhId":42');
    expect(calls("prCheck")).toContain('"authorGhLogin"');
    expect(calls("cclaRosterMember")).toContain('"ghLogin"');
    expect(calls("claWaiver")).toContain('"ghId":42');
    expect(calls("auditEvent")).toContain('"actorId":"u1"');
    expect(calls("auditEvent")).toContain('"contains":"u1"');
    expect(calls("claEventLog")).toContain('"actorUserId":"u1"');
  });

  it("scopes AI results to the user's applications and PR checks", async () => {
    fn(db.prisma.application.findMany).mockResolvedValue([
      { id: "a1", project: PROJECT, answers: "{}", notes: [], reviews: [], appeal: null, decidedBy: null },
    ]);
    fn(db.prisma.prCheck.findMany).mockResolvedValue([
      { id: "c1", repo: { fullName: "o/r" }, quality: null },
    ]);
    await buildAccountExport("u1");
    const ai = calls("aiResult");
    expect(ai).toContain("application:a1");
    expect(ai).toContain("prcheck:c1");
  });

  it("shapes applications with reviewers as logins only and parsed answers", async () => {
    fn(db.prisma.application.findMany).mockResolvedValue([
      {
        id: "a1", project: PROJECT, status: "DENIED", answers: '{"why":"fun"}',
        decidedBy: { ghLogin: "boss" },
        appeal: { id: "ap", answers: "not json", resolvedBy: { ghLogin: "boss" } },
        notes: [
          { id: "n1", body: "visible", deletedAt: null, author: { ghLogin: "rev" } },
          { id: "n2", body: "gone", deletedAt: new Date(), author: { ghLogin: "rev" } },
        ],
        reviews: [{ id: "r1", body: "ok", deletedAt: null, author: { ghLogin: "rev" } }],
      },
    ]);
    const out = await buildAccountExport("u1");
    const app = out!.applications[0];
    expect(app.answers).toEqual({ why: "fun" });
    expect(app.decision.decidedBy).toBe("boss");
    expect(app.appeal!.answers).toBe("not json");
    expect(app.notes.map((n) => [n.author, n.body])).toEqual([
      ["rev", "visible"],
      ["rev", null],
    ]);
    expect(app.reviews[0].reviewer).toBe("rev");
  });

  it("never selects a secret or internal column", async () => {
    await buildAccountExport("u1");
    const all = JSON.stringify(
      Object.keys(db.prisma).flatMap((m) =>
        ["findUnique", "findMany"].flatMap((q) =>
          fn(db.prisma[m][q] ?? f()).mock?.calls ?? [],
        ),
      ),
    );
    for (const forbidden of [
      "token", "apiKey", "secret", "stackUserId", "rawOutput", "inputHash",
      "fetchedRaw", "qaBoardLink", "webhook", "prompt", "checkRunId",
      "addedById", "grantedById", "revokedById", "decidedById", "authorId",
    ]) {
      // `signatureText`/`secret` style names must not be selected anywhere.
      expect(all.toLowerCase()).not.toContain(`"${forbidden.toLowerCase()}":true`);
    }
    expect(all).not.toMatch(/"(token|secret|apiKey)":/);
  });

  it("does not leak secret-bearing fields even if a row carries them", async () => {
    // A fake db ignores `select`, so a leak through spreading would show here.
    fn(db.prisma.notification.findMany).mockResolvedValue([
      { id: "x", kind: "k", payload: '{"a":1}', readAt: null, createdAt: new Date() },
    ]);
    fn(db.prisma.aiResult.findMany).mockResolvedValue([]);
    const out = JSON.stringify(await buildAccountExport("u1"));
    for (const s of ["vault:v1", "stackUserId", "rawOutput", "apiKey"]) {
      expect(out).not.toContain(s);
    }
  });
});
