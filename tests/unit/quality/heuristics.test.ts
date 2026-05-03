import { describe, expect, it } from "vitest";
import { ALL_HEURISTICS, HEURISTIC_BY_ID } from "@/lib/quality/registry";
import type { PrContext } from "@/lib/quality/types";

function ctx(partial: Partial<PrContext> = {}): PrContext {
  return {
    project: {
      id: "p1",
      qualityConfig: {},
      prTemplateHoneypots: [],
    },
    pr: {
      number: 1,
      title: "Add a feature that does the thing properly",
      body: "Describes the change.",
      headSha: "abc",
      authorLogin: "alice",
    },
    files: [],
    filesTruncated: false,
    commits: [],
    account: { login: "alice" },
    ...partial,
  };
}

function get(id: string) {
  const h = HEURISTIC_BY_ID.get(id);
  if (!h) throw new Error(`unknown heuristic ${id}`);
  return h;
}

describe("size heuristics", () => {
  it("size.file_count fires above threshold", () => {
    const h = get("size.file_count");
    const c = ctx({
      files: Array.from({ length: 60 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        changes: 1,
      })),
    });
    expect(h.run(c, 50).failed).toBe(true);
    expect(h.run(c, 100).failed).toBe(false);
  });

  it("size.line_count uses additions+deletions", () => {
    const h = get("size.line_count");
    const c = ctx({
      files: [
        {
          filename: "a.ts",
          status: "modified",
          additions: 6000,
          deletions: 5000,
          changes: 11000,
        },
      ],
    });
    expect(h.run(c, 10000).failed).toBe(true);
  });
});

describe("PR text heuristics", () => {
  it("pr.body_empty fires only when whitespace-only", () => {
    const h = get("pr.body_empty");
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "   \n  " } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "ok" } }), undefined).failed).toBe(false);
  });

  it("pr.title_vague flags short / generic titles", () => {
    const h = get("pr.title_vague");
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "fix" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "Update" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "🎉🎉🎉" } }), undefined).failed).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, title: "Add OAuth provider for SSO" } }), undefined).failed
    ).toBe(false);
  });

  it("pr.ai_watermark catches common AI phrases", () => {
    const h = get("pr.ai_watermark");
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "Here is the updated implementation." } }), undefined)
        .failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "As an AI language model I cannot..." } }), undefined)
        .failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "Refactored the queue to be lock-free." } }), undefined)
        .failed
    ).toBe(false);
  });

  it("pr.honeypot_hit only fires when a configured honeypot string is in the body", () => {
    const h = get("pr.honeypot_hit");
    const c = ctx({
      project: { id: "p1", qualityConfig: {}, prTemplateHoneypots: ["bait-token-xyz"] },
      pr: { ...ctx().pr, body: "Notes... bait-token-xyz" },
    });
    expect(h.run(c, undefined).failed).toBe(true);
    expect(
      h.run({ ...c, pr: { ...c.pr, body: "no honeypot here" } }, undefined).failed
    ).toBe(false);
  });
});

describe("code heuristics", () => {
  it("code.lockfile_only fires when only lockfiles changed", () => {
    const h = get("code.lockfile_only");
    expect(
      h.run(
        ctx({
          files: [
            {
              filename: "pnpm-lock.yaml",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
        }),
        undefined
      ).failed
    ).toBe(true);
    expect(
      h.run(
        ctx({
          files: [
            {
              filename: "src/foo.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
        }),
        undefined
      ).failed
    ).toBe(false);
  });

  it("code.test_to_code_ratio fires when source is added without tests", () => {
    const h = get("code.test_to_code_ratio");
    const noTests = ctx({
      files: [
        { filename: "src/feat.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
      ],
    });
    expect(h.run(noTests, undefined).failed).toBe(true);
    const withTests = ctx({
      files: [
        { filename: "src/feat.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
        {
          filename: "tests/unit/feat.test.ts",
          status: "added",
          additions: 12,
          deletions: 0,
          changes: 12,
        },
      ],
    });
    expect(h.run(withTests, undefined).failed).toBe(false);
  });
});

describe("registry sanity", () => {
  it("every heuristic has a unique id", () => {
    const ids = ALL_HEURISTICS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every heuristic has a positive integer weight 1..3", () => {
    for (const h of ALL_HEURISTICS) {
      expect([1, 2, 3]).toContain(h.weight);
    }
  });
});
