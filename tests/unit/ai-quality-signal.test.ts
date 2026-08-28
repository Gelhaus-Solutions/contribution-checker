import { describe, expect, it } from "vitest";
import { HEURISTIC_BY_ID, parseQualityConfig } from "@/lib/quality/registry";
import { computeScore } from "@/lib/quality/score";
import { prQualityTask } from "@/lib/ai/tasks/pr-quality";
import type { PrContext, SignalsRaw } from "@/lib/quality/types";

function ctx(partial: Partial<PrContext> = {}): PrContext {
  return {
    project: {
      id: "p1",
      qualityConfig: {},
      prTemplateHoneypots: [],
      templateMatchPct: 80,
    },
    pr: { number: 1, title: "t", body: "b", headSha: "sha", authorLogin: "alice" },
    prTemplate: null,
    files: [],
    filesTruncated: false,
    commits: [],
    account: { login: "alice" },
    ...partial,
  };
}

const h = HEURISTIC_BY_ID.get("pr.ai_assessment")!;

const verdict = (assessment: number) => ({
  assessment,
  reason: "the description says docs but the diff is auth code",
  modelId: "google/gemini-3.5-flash-lite",
  computedAt: new Date().toISOString(),
});

describe("pr.ai_assessment", () => {
  it("reports no signal when no AI run has happened", () => {
    // The common case by far: runs are manual, so most PRs never have one.
    expect(h.run(ctx(), 40)).toBeNull();
    expect(h.run(ctx({ ai: null }), 40)).toBeNull();
  });

  it("fires below the threshold and stays quiet above it", () => {
    expect(h.run(ctx({ ai: verdict(20) }), 40)?.failed).toBe(true);
    expect(h.run(ctx({ ai: verdict(80) }), 40)?.failed).toBe(false);
  });

  it("treats the threshold as exclusive at the boundary", () => {
    expect(h.run(ctx({ ai: verdict(40) }), 40)?.failed).toBe(false);
    expect(h.run(ctx({ ai: verdict(39) }), 40)?.failed).toBe(true);
  });

  it("carries the model's reason through for the reviewer", () => {
    expect(h.run(ctx({ ai: verdict(10) }), 40)?.reason).toContain("auth code");
  });

  it("is off by default and weighted below blocker level", () => {
    expect(h.defaultEnabled).toBe(false);
    // Weight 4 caps the whole score. A model opinion formed without the diff
    // must never be the reason a contribution is treated as slop.
    expect(h.weight).toBeLessThan(4);
  });

  it("performs no I/O: two runs on one context give identical results", () => {
    const c = ctx({ ai: verdict(33) });
    expect(h.run(c, 40)).toEqual(h.run(c, 40));
  });
});

describe("scoring is unchanged when no AI verdict exists", () => {
  const config = parseQualityConfig(
    JSON.stringify({
      "pr.ai_assessment": { enabled: true },
      "size.file_count": { enabled: true },
    })
  );

  it("excludes the heuristic from the weight total entirely", () => {
    // An un-run signal must be invisible to scoring: not a penalty, and not
    // free credit either.
    const withoutAi: SignalsRaw = { "size.file_count": { failed: false } };
    const bare = computeScore(withoutAi, config);

    expect(bare.failedIds).not.toContain("pr.ai_assessment");
    expect(bare.passedIds).not.toContain("pr.ai_assessment");
    expect(bare.totalWeight).toBe(HEURISTIC_BY_ID.get("size.file_count")!.weight);
    expect(bare.score).toBe(100);
  });

  it("only affects the score once a verdict has actually been recorded", () => {
    const withAi: SignalsRaw = {
      "size.file_count": { failed: false },
      "pr.ai_assessment": { failed: true, value: 15 },
    };
    const scored = computeScore(withAi, config);
    expect(scored.failedIds).toContain("pr.ai_assessment");
    expect(scored.score).toBeLessThan(100);
  });
});

describe("prQualityTask", () => {
  const base = {
    title: "Fix login",
    body: "Sessions expired too early.",
    files: [
      { filename: "src/auth.ts", status: "modified", additions: 30, deletions: 10 },
    ],
    commitMessages: ["fix: session ttl"],
  };

  it("skips a diff too small to misdescribe itself", () => {
    expect(
      prQualityTask.buildInput({
        ...base,
        files: [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1 }],
      })
    ).toBeNull();
  });

  it("builds input for a diff worth judging", () => {
    const built = prQualityTask.buildInput(base);
    expect(built).toContain("Fix login");
    expect(built).toContain("src/auth.ts");
  });

  it("rejects an out-of-range assessment", () => {
    const ok = { assessment: 50, reason: "r", descriptionMismatch: false };
    expect(prQualityTask.parse(ok)).not.toBeNull();
    expect(prQualityTask.parse({ ...ok, assessment: 140 })).toBeNull();
    expect(prQualityTask.parse({ ...ok, assessment: -1 })).toBeNull();
  });
});
