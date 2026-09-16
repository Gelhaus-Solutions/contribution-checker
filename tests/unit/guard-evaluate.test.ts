import { describe, expect, it } from "vitest";
import { evaluateGuard, guardPasses } from "@/lib/guard/evaluate";
import type { GuardEvaluateInput } from "@/lib/guard/evaluate";
import { resolveGuardConfig } from "@/lib/guard/config";
import { serializeGuardRules } from "@/lib/guard/rules";

function cfg(over: { approvers?: string[]; mode?: "either" | "both" } = {}) {
  return resolveGuardConfig({
    guardEnabled: true,
    guardRules: serializeGuardRules(["migrations"]),
    guardGlobs: "[]",
    guardApprovers: JSON.stringify(over.approvers ?? ["alice"]),
    guardUnlockMode: over.mode ?? "either",
    labelGuardUnlock: "guard:approved",
    labelGuardBlocked: "guard:blocked",
  });
}

const HIT = {
  path: "prisma/migrations/a/migration.sql",
  sha: "s1",
  ruleId: "migrations",
  reason: "Database migrations",
};

function input(over: Partial<GuardEvaluateInput> = {}): GuardEvaluateInput {
  return {
    cfg: cfg(),
    baseIsDefault: true,
    baseRef: "main",
    defaultBranch: "main",
    hits: [HIT],
    filesTruncated: false,
    reviews: [],
    labelUnlockBy: null,
    approvedFiles: {},
    priorUnlock: null,
    ...over,
  };
}

describe("evaluateGuard", () => {
  it("a PR onto a non-default base → not applicable", () => {
    const v = evaluateGuard(
      input({ baseIsDefault: false, baseRef: "staging" }),
    );
    expect(v.kind).toBe("not_applicable");
    expect(guardPasses(v)).toBe(true);
  });

  it("a project guarding nothing → not applicable, not a green check on every PR", () => {
    const disabled = resolveGuardConfig({
      guardEnabled: true,
      guardRules: "[]",
      guardGlobs: "[]",
      guardApprovers: "[]",
      guardUnlockMode: "either",
      labelGuardUnlock: "guard:approved",
      labelGuardBlocked: "guard:blocked",
    });
    expect(disabled.enabled).toBe(false);
    const v = evaluateGuard(input({ cfg: disabled }));
    expect(v.kind).toBe("not_applicable");
  });

  it("no guarded file touched → clear", () => {
    const v = evaluateGuard(input({ hits: [] }));
    expect(v.kind).toBe("clear");
    expect(guardPasses(v)).toBe(true);
  });

  it("guarded files and nobody has signed off → blocked", () => {
    const v = evaluateGuard(input());
    expect(v.kind).toBe("blocked");
    expect(guardPasses(v)).toBe(false);
    if (v.kind === "blocked") expect(v.missing).toBe("any");
  });

  it("an approving review from an approver unlocks it", () => {
    const v = evaluateGuard(
      input({ reviews: [{ login: "alice", state: "APPROVED" }] }),
    );
    expect(v.kind).toBe("unlocked");
    if (v.kind === "unlocked") {
      expect(v.unlocks).toEqual([{ source: "review", by: "alice" }]);
    }
  });

  it("an approving review from someone else does not", () => {
    const v = evaluateGuard(
      input({ reviews: [{ login: "mallory", state: "APPROVED" }] }),
    );
    expect(v.kind).toBe("blocked");
  });

  // A reviewer who approved and then requested changes is not approving, and a
  // dismissed approval is not one either.
  it("a non-APPROVED state from an approver does not unlock", () => {
    for (const state of ["CHANGES_REQUESTED", "DISMISSED", "COMMENTED"]) {
      const v = evaluateGuard(input({ reviews: [{ login: "alice", state }] }));
      expect(v.kind).toBe("blocked");
    }
  });

  it("the unlock label, recorded from an approver, unlocks it", () => {
    const v = evaluateGuard(input({ labelUnlockBy: "alice" }));
    expect(v.kind).toBe("unlocked");
    if (v.kind === "unlocked") {
      expect(v.unlocks).toEqual([{ source: "label", by: "alice" }]);
    }
  });

  // Trust comes from who applied it, not from the label sitting on the PR.
  it("a label recorded against a non-approver does not unlock", () => {
    const v = evaluateGuard(input({ labelUnlockBy: "mallory" }));
    expect(v.kind).toBe("blocked");
  });

  it("approvers support globs", () => {
    const v = evaluateGuard(
      input({
        cfg: cfg({ approvers: ["platform-*"] }),
        reviews: [{ login: "platform-bot", state: "APPROVED" }],
      }),
    );
    expect(v.kind).toBe("unlocked");
  });

  describe("unlockMode: both", () => {
    it("review alone is not enough", () => {
      const v = evaluateGuard(
        input({
          cfg: cfg({ mode: "both" }),
          reviews: [{ login: "alice", state: "APPROVED" }],
        }),
      );
      expect(v.kind).toBe("blocked");
      if (v.kind === "blocked") expect(v.missing).toBe("label");
    });

    it("label alone is not enough", () => {
      const v = evaluateGuard(
        input({ cfg: cfg({ mode: "both" }), labelUnlockBy: "alice" }),
      );
      expect(v.kind).toBe("blocked");
      if (v.kind === "blocked") expect(v.missing).toBe("review");
    });

    it("both together unlock it", () => {
      const v = evaluateGuard(
        input({
          cfg: cfg({ mode: "both" }),
          reviews: [{ login: "alice", state: "APPROVED" }],
          labelUnlockBy: "alice",
        }),
      );
      expect(v.kind).toBe("unlocked");
      if (v.kind === "unlocked") expect(v.unlocks).toHaveLength(2);
    });

    // A snapshot records that the files were signed off, not that both routes
    // still say so, so it cannot stand in for a missing half.
    it("a covering snapshot does not substitute for a missing half", () => {
      const v = evaluateGuard(
        input({
          cfg: cfg({ mode: "both" }),
          approvedFiles: { [HIT.path]: HIT.sha },
          priorUnlock: { source: "review", by: "alice" },
        }),
      );
      expect(v.kind).toBe("blocked");
    });
  });

  describe("the stored sign-off", () => {
    // The point of storing blob SHAs: a push touching only ordinary files
    // leaves every guarded blob where it was, so the unlock survives it.
    it("still covers the diff when nothing guarded changed", () => {
      const v = evaluateGuard(
        input({
          reviews: null,
          approvedFiles: { [HIT.path]: HIT.sha },
          priorUnlock: { source: "review", by: "alice" },
        }),
      );
      expect(v.kind).toBe("unlocked");
      if (v.kind === "unlocked") {
        expect(v.unlocks).toEqual([{ source: "review", by: "alice" }]);
      }
    });

    it("stops covering once a guarded blob changes", () => {
      const v = evaluateGuard(
        input({
          reviews: [],
          hits: [{ ...HIT, sha: "s2" }],
          approvedFiles: { [HIT.path]: "s1" },
          priorUnlock: { source: "review", by: "alice" },
        }),
      );
      expect(v.kind).toBe("blocked");
    });

    it("stops covering when a new guarded file joins the diff", () => {
      const v = evaluateGuard(
        input({
          reviews: [],
          hits: [HIT, { ...HIT, path: "prisma/migrations/b/migration.sql" }],
          approvedFiles: { [HIT.path]: HIT.sha },
          priorUnlock: { source: "review", by: "alice" },
        }),
      );
      expect(v.kind).toBe("blocked");
    });

    // A failed reviews read is not evidence that nobody approved.
    it("carries the PR when the reviews call could not be made", () => {
      const v = evaluateGuard(
        input({
          reviews: null,
          approvedFiles: { [HIT.path]: HIT.sha },
          priorUnlock: { source: "label", by: "alice" },
        }),
      );
      expect(v.kind).toBe("unlocked");
    });
  });

  // The one failure mode a guard cannot have is passing because it stopped
  // looking, so truncation outranks "the files we did see look fine".
  describe("a diff too large to read", () => {
    it("fails closed even when no guarded file was seen", () => {
      const v = evaluateGuard(input({ hits: [], filesTruncated: true }));
      expect(v.kind).toBe("undecidable");
      expect(guardPasses(v)).toBe(false);
    });

    it("fails closed even with a covering sign-off", () => {
      const v = evaluateGuard(
        input({
          hits: [],
          filesTruncated: true,
          approvedFiles: { [HIT.path]: HIT.sha },
          priorUnlock: { source: "review", by: "alice" },
        }),
      );
      expect(v.kind).toBe("undecidable");
    });

    // But a PR not aimed at the default branch is outside the guard's remit
    // whether or not we could read its diff.
    it("still does not apply off the default branch", () => {
      const v = evaluateGuard(
        input({ baseIsDefault: false, filesTruncated: true }),
      );
      expect(v.kind).toBe("not_applicable");
    });
  });
});
