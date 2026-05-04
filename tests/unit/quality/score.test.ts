import { describe, expect, it } from "vitest";
import { computeScore } from "@/lib/quality/score";
import { ALL_HEURISTICS } from "@/lib/quality/registry";

// Build a config that disables every heuristic except the named ones.
function configWithOnly(...ids: string[]) {
  const config: Record<string, { enabled: boolean }> = {};
  for (const h of ALL_HEURISTICS) config[h.id] = { enabled: ids.includes(h.id) };
  return config;
}

describe("computeScore", () => {
  it("returns null when no heuristics ran or no enabled heuristic has a recorded signal", () => {
    const config = configWithOnly("size.file_count");
    const summary = computeScore({}, config);
    expect(summary.score).toBeNull();
    expect(summary.failedIds).toEqual([]);
    expect(summary.passedIds).toEqual([]);
  });

  it("returns 100 when all enabled heuristics passed", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: false },
      "size.line_count": { failed: false },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(100);
    expect(summary.failedIds).toEqual([]);
    expect(summary.passedIds.length).toBe(2);
  });

  it("deducts weight*10 per failed non-w4 heuristic", () => {
    // Two w2 heuristics fail → 100 - 2*10 - 2*10 = 60.
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: true },
      "size.line_count": { failed: true },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(60);
    expect(summary.failedIds.length).toBe(2);
  });

  it("scales penalty by heuristic weight, not equal-weight", () => {
    // size.mega_pr is weight 3; size.file_count is weight 2.
    // Pass mega_pr, fail file_count → 100 - 2*10 = 80.
    const config = configWithOnly("size.file_count", "size.mega_pr");
    const signals = {
      "size.file_count": { failed: true },
      "size.mega_pr": { failed: false },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(80);
  });

  it("floors at 0 when accumulated deductions exceed the ceiling", () => {
    // 4x w3 fails = -120. score = max(0, 100 - 120) = 0.
    const config = configWithOnly(
      "size.mega_pr",
      "size.trivial_patch",
      "code.lockfile_only",
      "account.mass_forking"
    );
    const signals = {
      "size.mega_pr": { failed: true },
      "size.trivial_patch": { failed: true },
      "code.lockfile_only": { failed: true },
      "account.mass_forking": { failed: true },
    };
    expect(computeScore(signals, config).score).toBe(0);
  });

  it("ignores heuristics that have no recorded signal even if enabled", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = { "size.file_count": { failed: false } }; // line_count missing
    const summary = computeScore(signals, config);
    // Only file_count contributed; treated as 100% on the heuristics that ran.
    expect(summary.score).toBe(100);
    expect(summary.failedIds).toEqual([]);
    expect(summary.passedIds).toEqual(["size.file_count"]);
  });

  it("ignores disabled heuristics even when their signal exists in storage", () => {
    const config = configWithOnly("size.file_count");
    const signals = {
      "size.file_count": { failed: false },
      "size.line_count": { failed: true },
      "pr.body_empty": { failed: true },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(100);
    expect(summary.failedIds).toEqual([]);
  });

  it("applies scoreCap from a failed signal as a ceiling, then deducts", () => {
    // line_count(w2) fails with cap 25. mega_pr(w3) passes.
    // ceiling = 25, deductions = 2*10 = 20 → score = 5.
    const config = configWithOnly("size.line_count", "size.mega_pr");
    const signals = {
      "size.line_count": { failed: true, scoreCap: 25 },
      "size.mega_pr": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(5);
  });

  it("takes the lowest cap when multiple failed signals set one", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: true, scoreCap: 50 },
      "size.line_count": { failed: true, scoreCap: 25 },
    };
    // ceiling = min(50, 25) = 25; deductions = 4*10 = 40 → max(0, -15) = 0.
    expect(computeScore(signals, config).score).toBe(0);
  });

  it("caps the score at 50 when one w4 heuristic fires", () => {
    const config = configWithOnly(
      "pr.ai_watermark",
      "size.file_count",
      "size.line_count",
      "size.mega_pr"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "size.file_count": { failed: false },
      "size.line_count": { failed: false },
      "size.mega_pr": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(50);
  });

  it("caps the score at 35 when two w4 heuristics fire", () => {
    const config = configWithOnly(
      "pr.ai_watermark",
      "pr.uses_template",
      "size.file_count",
      "size.line_count"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "pr.uses_template": { failed: true },
      "size.file_count": { failed: false },
      "size.line_count": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(35);
  });

  it("caps the score at 20 when three or more w4 heuristics fire", () => {
    const config = configWithOnly(
      "pr.ai_watermark",
      "pr.uses_template",
      "pr.honeypot_hit",
      "size.file_count"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "pr.uses_template": { failed: true },
      "pr.honeypot_hit": { failed: true },
      "size.file_count": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(20);
  });

  it("further reduces the w4 cap when lower-weight heuristics also fail", () => {
    // 1 w4 fires → ceiling = 50. line_count(w2) also fails → -20. score = 30.
    const config = configWithOnly(
      "pr.ai_watermark",
      "size.file_count",
      "size.line_count"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "size.file_count": { failed: false },
      "size.line_count": { failed: true },
    };
    expect(computeScore(signals, config).score).toBe(30);
  });

  it("drops to 0 when w4 fires and enough lower-weight heuristics fail to exhaust the cap", () => {
    // ceiling = 50. Three w2 fails = -60 → max(0, -10) = 0.
    const config = configWithOnly(
      "pr.ai_watermark",
      "size.file_count",
      "size.line_count",
      "code.test_to_code_ratio"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "size.file_count": { failed: true },
      "size.line_count": { failed: true },
      "code.test_to_code_ratio": { failed: true },
    };
    expect(computeScore(signals, config).score).toBe(0);
  });

  it("keeps the w4 cap as the score when all non-w4 heuristics pass", () => {
    const config = configWithOnly(
      "pr.ai_watermark",
      "size.file_count",
      "size.line_count"
    );
    const signals = {
      "pr.ai_watermark": { failed: true },
      "size.file_count": { failed: false },
      "size.line_count": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(50);
  });

  it("does not apply scoreCap from a passing signal", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: false, scoreCap: 10 },
      "size.line_count": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(100);
  });

  it("scores PRs with multiple small fails meaningfully below 100", () => {
    // Real-world scenario: 4 minor-to-medium fails should not score 92%.
    // body_inline_code_refs(w1) + commit.author_mismatch(w2) +
    // commit.conv_commits(w1) + account.no_email(w1) →
    // deductions = 10 + 20 + 10 + 10 = 50. score = 50.
    const config = configWithOnly(
      "pr.body_inline_code_refs",
      "commit.author_mismatch",
      "commit.conv_commits",
      "account.no_email",
      "size.file_count",
      "size.line_count",
      "pr.body_empty",
      "pr.title_vague"
    );
    const signals = {
      "pr.body_inline_code_refs": { failed: true },
      "commit.author_mismatch": { failed: true },
      "commit.conv_commits": { failed: true },
      "account.no_email": { failed: true },
      "size.file_count": { failed: false },
      "size.line_count": { failed: false },
      "pr.body_empty": { failed: false },
      "pr.title_vague": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(50);
  });
});
