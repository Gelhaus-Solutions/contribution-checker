import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ prisma: {} as Record<string, Record<string, unknown>> }));
const secrets = vi.hoisted(() => ({ value: "test-key" as string | null }));
vi.mock("@/lib/db", () => db);
vi.mock("@/lib/gpterms", () => ({ closeAccount: vi.fn() }));
vi.mock("@/lib/vault/resolver", () => ({ getSecret: vi.fn(async () => secrets.value) }));
vi.mock("@/lib/env", () => ({ env: { stackConfigured: false } }));

import { PRIVACY_CATALOGUE, planProblems, pseudonymOf, runPrivacyPlan } from "@/lib/account-erasure";

const defaults = () => Object.fromEntries(PRIVACY_CATALOGUE.map((one) => [one.id, one.default]));

describe("planProblems", () => {
  it("accepts the catalogue's own defaults", () => {
    expect(planProblems(defaults())).toEqual([]);
  });
  it("wants every category, with an action it offers", () => {
    const plan = defaults();
    delete plan["notifications"];
    plan["prQuality"] = "pseudonymise";
    expect(planProblems(plan)).toEqual(["prQuality cannot be pseudonymise", "no action for notifications"]);
  });
  it("refuses keeping what a deletion takes with it", () => {
    expect(planProblems({ ...defaults(), account: "delete" })).toContain("deleting account deletes applications too");
  });
});

describe("pseudonymOf", () => {
  it("is stable for one key, whatever the case, and differs between keys", () => {
    const a = pseudonymOf("k1", "github", "Someone");
    expect(pseudonymOf("k1", "github", "someone ")).toEqual(a);
    expect(pseudonymOf("k2", "github", "someone").text).not.toBe(a.text);
    expect(a.text).toMatch(/^anon-[0-9a-f]{24}$/);
    expect(a.id).toBeLessThan(0);
  });
});

describe("runPrivacyPlan, dry run", () => {
  const f = () => vi.fn();
  beforeEach(() => {
    secrets.value = "test-key";
    db.prisma = {
      user: { findMany: f() },
      application: { findMany: f() },
      prCheck: { findMany: f() },
      applicationAppeal: { count: f() },
      applicationNote: { count: f() },
      applicationReview: { count: f() },
      prQuality: { count: f() },
      aiResult: { count: f() },
      notification: { count: f() },
      auditEvent: { count: f() },
      stagingBatchItem: { count: f() },
      claSignature: { count: f() },
      manualDecision: { count: f() },
      $transaction: f() as unknown as Record<string, unknown>,
    };
    const m = (model: string, fn: string) => db.prisma[model][fn] as ReturnType<typeof vi.fn>;
    m("user", "findMany").mockResolvedValue([{ id: "u1", email: "a@example.org", ghLogin: "Someone", ghId: 7, stackUserId: "s1" }]);
    m("application", "findMany").mockResolvedValue([{ id: "app1" }]);
    m("prCheck", "findMany").mockResolvedValue([{ id: "pr1" }]);
    for (const [model, n] of Object.entries({ applicationAppeal: 0, applicationNote: 1, applicationReview: 0, prQuality: 1, aiResult: 0, notification: 3, auditEvent: 2, stagingBatchItem: 0, claSignature: 1, manualDecision: 0 })) {
      m(model, "count").mockResolvedValue(n);
    }
  });

  it("counts per category, keeps what is kept at zero, writes nothing and names the signature it never touches", async () => {
    const report = await runPrivacyPlan(
      { email: "a@example.org", identifiers: { github: "someone" }, accountIds: [] },
      { ...defaults(), applications: "keep", applicationText: "delete" },
      { execute: false, requestRef: "DSR-2026-10-03-1" },
    );
    expect(report.found).toMatchObject({ account: 1, applications: 1, applicationText: 2, prChecks: 1, prQuality: 1, notifications: 3, auditEvents: 2 });
    expect(report.done["applications"]).toEqual({ action: "keep", count: 0 });
    expect(report.done["account"]).toEqual({ action: "pseudonymise", count: 1 });
    expect(report.kept.map((one) => one.what)).toEqual(["CLA signatures"]);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("says a dry run would fail without the pseudonym key, and refuses to execute without it", async () => {
    secrets.value = null;
    const subject = { email: null, identifiers: { github: "someone" }, accountIds: [] };
    const dry = await runPrivacyPlan(subject, defaults(), { execute: false, requestRef: "DSR-1" });
    expect(dry.notes[0]).toMatch(/PRIVACY_PSEUDONYM_KEY/);
    await expect(runPrivacyPlan(subject, defaults(), { execute: true, requestRef: "DSR-1" })).rejects.toThrow(/PRIVACY_PSEUDONYM_KEY/);
  });

  it("refuses a reference that could carry personal data", async () => {
    await expect(
      runPrivacyPlan({ email: null, identifiers: { github: "x" }, accountIds: [] }, defaults(), { execute: false, requestRef: "a@example.org" }),
    ).rejects.toThrow(/reference/);
  });
});
