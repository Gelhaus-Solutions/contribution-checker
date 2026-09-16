import { describe, expect, it } from "vitest";
import {
  buildGuardCheckPayload,
  buildMergeGroupGuardPayload,
} from "@/lib/guard/render";
import type { GuardVerdict } from "@/lib/guard/evaluate";

const hit = (path: string, reason = "Database migrations") => ({
  path,
  sha: "s1",
  ruleId: "migrations",
  reason,
});

describe("buildGuardCheckPayload", () => {
  it("not applicable off the default branch → success, naming both branches", () => {
    const p = buildGuardCheckPayload({
      kind: "not_applicable",
      reason: { kind: "base", baseRef: "staging", defaultBranch: "main" },
    });
    expect(p.conclusion).toBe("success");
    expect(p.summary).toContain("staging");
    expect(p.summary).toContain("main");
  });

  it("clear → success", () => {
    const p = buildGuardCheckPayload({ kind: "clear" });
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("No guarded paths touched");
  });

  it("unlocked → success, naming who signed off", () => {
    const p = buildGuardCheckPayload({
      kind: "unlocked",
      hits: [hit("prisma/migrations/a/migration.sql")],
      unlocks: [{ source: "review", by: "alice" }],
    });
    expect(p.conclusion).toBe("success");
    expect(p.title).toContain("alice");
  });

  // The user asked for a FAIL, not an action_required nudge: this is a gate.
  it("blocked → failure, listing the paths and the way out", () => {
    const p = buildGuardCheckPayload({
      kind: "blocked",
      hits: [hit("prisma/migrations/a/migration.sql")],
      missing: "any",
      approvers: ["alice"],
      unlockLabel: "guard:approved",
    });
    expect(p.conclusion).toBe("failure");
    expect(p.summary).toContain("prisma/migrations/a/migration.sql");
    expect(p.summary).toContain("alice");
    expect(p.summary).toContain("guard:approved");
  });

  it("undecidable → failure, saying it stopped looking", () => {
    const p = buildGuardCheckPayload({
      kind: "undecidable",
      reason: "diff_too_large",
    });
    expect(p.conclusion).toBe("failure");
    expect(p.title).toBe("Diff too large to verify");
  });

  it("a project with no approvers says only the label can clear it", () => {
    const p = buildGuardCheckPayload({
      kind: "blocked",
      hits: [hit("a.sql")],
      missing: "any",
      approvers: [],
      unlockLabel: "guard:approved",
    });
    expect(p.summary).toContain("this project has none set yet");
  });

  // The summary is republished on every event; instability would rewrite the
  // check each time for no reason.
  it("is deterministic for the same verdict", () => {
    const v: GuardVerdict = {
      kind: "blocked",
      hits: [hit("b.sql", "Dependencies"), hit("a.sql")],
      missing: "any",
      approvers: ["alice", "bob"],
      unlockLabel: "guard:approved",
    };
    expect(buildGuardCheckPayload(v)).toEqual(buildGuardCheckPayload(v));
  });

  it("caps the path list and says how many it dropped", () => {
    const hits = Array.from({ length: 40 }, (_, i) =>
      hit(`prisma/migrations/m${String(i).padStart(2, "0")}/migration.sql`),
    );
    const p = buildGuardCheckPayload({
      kind: "blocked",
      hits,
      missing: "any",
      approvers: ["alice"],
      unlockLabel: "guard:approved",
    });
    expect(p.summary).toContain("...and 25 more");
    expect(p.title).toContain("40 guarded files");
  });
});

describe("buildMergeGroupGuardPayload", () => {
  it("a group onto another branch → success", () => {
    const p = buildMergeGroupGuardPayload({
      kind: "not_applicable",
      baseRef: "staging",
      defaultBranch: "main",
    });
    expect(p.conclusion).toBe("success");
    // Not "this PR": a queue commit carries several.
    expect(p.summary).toContain("merge group");
  });

  it("names the members holding the queue up, in order", () => {
    const p = buildMergeGroupGuardPayload({
      kind: "blocked",
      prNumbers: [12, 3],
    });
    expect(p.conclusion).toBe("failure");
    expect(p.summary.indexOf("- #3")).toBeLessThan(p.summary.indexOf("- #12"));
    expect(p.title).toBe("2 PRs in this group are awaiting sign-off");
  });

  it("uses the singular for one member", () => {
    const p = buildMergeGroupGuardPayload({ kind: "blocked", prNumbers: [7] });
    expect(p.title).toBe("A PR in this group is awaiting sign-off");
  });

  it("clear → success, so the queue drains", () => {
    expect(buildMergeGroupGuardPayload({ kind: "clear" }).conclusion).toBe(
      "success",
    );
  });
});

describe("the approver list", () => {
  // Any ONE of them clears it. Joining with "and" describes a rule that needs
  // all of them, which is heavier than what is actually enforced and would send
  // a contributor chasing signatures they do not need.
  it("joins approvers with 'or', never 'and'", () => {
    const p = buildGuardCheckPayload({
      kind: "blocked",
      hits: [hit("a.sql")],
      missing: "any",
      approvers: ["nevo-david", "egelhaus"],
      unlockLabel: "guard:approved",
    });
    expect(p.summary).toContain("`nevo-david` or `egelhaus`");
    expect(p.summary).not.toContain("`nevo-david` and `egelhaus`");
  });

  it("uses commas then 'or' for three or more", () => {
    const p = buildGuardCheckPayload({
      kind: "blocked",
      hits: [hit("a.sql")],
      missing: "any",
      approvers: ["a", "b", "c"],
      unlockLabel: "guard:approved",
    });
    expect(p.summary).toContain("`a`, `b` or `c`");
  });

  // The people who DID sign off are a genuine "and": both of them really did.
  it("still joins actual signatories with 'and'", () => {
    const p = buildGuardCheckPayload({
      kind: "unlocked",
      hits: [hit("a.sql")],
      unlocks: [
        { source: "review", by: "alice" },
        { source: "label", by: "bob" },
      ],
    });
    expect(p.title).toContain("alice and bob");
  });
});
