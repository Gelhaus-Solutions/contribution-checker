import { describe, expect, it } from "vitest";
import { matchGuardedFiles, unlockCovers } from "@/lib/guard/match";
import { resolveGuardConfig } from "@/lib/guard/config";
import { serializeGuardRules } from "@/lib/guard/rules";

function cfg(over: {
  rules?: string[];
  globs?: string[];
  approvers?: string[];
}) {
  return resolveGuardConfig({
    guardEnabled: true,
    guardRules: serializeGuardRules(over.rules ?? []),
    guardGlobs: JSON.stringify(over.globs ?? []),
    guardApprovers: JSON.stringify(over.approvers ?? []),
    guardUnlockMode: "either",
    labelGuardUnlock: "guard:approved",
    labelGuardBlocked: "guard:blocked",
  });
}

const file = (filename: string, sha = "sha1", status = "modified") => ({
  filename,
  sha,
  status,
});

describe("matchGuardedFiles", () => {
  it("catches a migration through the catalog rule", () => {
    const hits = matchGuardedFiles(
      [file("prisma/migrations/20260101_x/migration.sql")],
      cfg({ rules: ["migrations"] }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe("migrations");
    expect(hits[0].reason).toBe("Database migrations");
  });

  it("ignores a rule the project did not tick", () => {
    const hits = matchGuardedFiles(
      [file("prisma/migrations/20260101_x/migration.sql")],
      cfg({ rules: ["workflows"] }),
    );
    expect(hits).toEqual([]);
  });

  // A deleted migration is a change to migrations, and deleting a workflow is
  // exactly the edit a guard exists to catch. Status must not filter.
  it("counts a deleted guarded file", () => {
    const hits = matchGuardedFiles(
      [file(".github/workflows/deploy.yml", "sha9", "removed")],
      cfg({ rules: ["workflows"] }),
    );
    expect(hits).toHaveLength(1);
  });

  it("matches dotfile paths through a custom glob", () => {
    const hits = matchGuardedFiles(
      [file(".github/dependabot.yml")],
      cfg({ globs: [".github/**"] }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBeNull();
    expect(hits[0].reason).toBe(".github/**");
  });

  // Writing the recursive form is what people forget, and a glob that matches
  // nothing is a guard that is not there.
  it("treats a bare directory name as everything under it", () => {
    const bare = matchGuardedFiles(
      [file("src/lib/billing/charge.ts")],
      cfg({ globs: ["src/lib/billing"] }),
    );
    const slashed = matchGuardedFiles(
      [file("src/lib/billing/charge.ts")],
      cfg({ globs: ["src/lib/billing/"] }),
    );
    expect(bare).toHaveLength(1);
    expect(slashed).toHaveLength(1);
  });

  it("reports a file once when a rule and a glob both claim it", () => {
    const hits = matchGuardedFiles(
      [file("prisma/migrations/20260101_x/migration.sql")],
      cfg({ rules: ["migrations"], globs: ["prisma/**"] }),
    );
    expect(hits).toHaveLength(1);
    // The catalog label reads better than the pattern, so it wins.
    expect(hits[0].reason).toBe("Database migrations");
  });

  it("guards Temporal workflow and activity code", () => {
    const hits = matchGuardedFiles(
      [
        file("src/worker/workflows/pr-gate.ts"),
        file("src/worker/activities/github.ts"),
        file("src/lib/temporal/contracts.ts"),
        file("src/lib/ui/format.ts"),
      ],
      cfg({ rules: ["temporal"] }),
    );
    expect(hits.map((h) => h.path)).toEqual([
      "src/lib/temporal/contracts.ts",
      "src/worker/activities/github.ts",
      "src/worker/workflows/pr-gate.ts",
    ]);
  });

  // The comment and the check summary are diffed before they are written, so an
  // unstable order would edit them on every event.
  it("returns hits sorted by path", () => {
    const hits = matchGuardedFiles(
      [file("package.json"), file("Cargo.toml"), file("go.mod")],
      cfg({ rules: ["dependencies"] }),
    );
    expect(hits.map((h) => h.path)).toEqual([
      "Cargo.toml",
      "go.mod",
      "package.json",
    ]);
  });

  it("finds nothing when the project guards nothing", () => {
    expect(matchGuardedFiles([file("package.json")], cfg({}))).toEqual([]);
  });
});

describe("unlockCovers", () => {
  const hit = (path: string, sha: string) => ({
    path,
    sha,
    ruleId: null,
    reason: "g",
  });

  it("covers a diff whose guarded blobs are all signed off", () => {
    expect(
      unlockCovers([hit("a.sql", "s1"), hit("b.sql", "s2")], {
        "a.sql": "s1",
        "b.sql": "s2",
      }),
    ).toBe(true);
  });

  it("stops covering once a guarded blob changes", () => {
    expect(unlockCovers([hit("a.sql", "s2")], { "a.sql": "s1" })).toBe(false);
  });

  it("stops covering when a new guarded file appears", () => {
    expect(
      unlockCovers([hit("a.sql", "s1"), hit("b.sql", "s2")], { "a.sql": "s1" }),
    ).toBe(false);
  });

  // The question is whether everything present was signed off, not whether the
  // diff is unchanged: a guarded file dropped from the PR cannot block it.
  it("ignores approved files no longer in the diff", () => {
    expect(
      unlockCovers([hit("a.sql", "s1")], { "a.sql": "s1", "gone.sql": "s9" }),
    ).toBe(true);
  });

  it("trivially covers a diff with nothing guarded in it", () => {
    expect(unlockCovers([], {})).toBe(true);
  });
});
