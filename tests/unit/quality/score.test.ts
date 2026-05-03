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

  it("returns 0 when all enabled heuristics failed", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: true },
      "size.line_count": { failed: true },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(0);
    expect(summary.failedIds.length).toBe(2);
  });

  it("uses heuristic weight, not equal-weight", () => {
    // size.mega_pr is weight 3; size.file_count is weight 2.
    // Pass mega_pr, fail file_count → earned=3, total=5 → 60%.
    const config = configWithOnly("size.file_count", "size.mega_pr");
    const signals = {
      "size.file_count": { failed: true },
      "size.mega_pr": { failed: false },
    };
    const summary = computeScore(signals, config);
    expect(summary.score).toBe(60);
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

  it("applies scoreCap from a failed signal", () => {
    // size.line_count fails (weight 2) — pre-cap score = 60% (3/5).
    // size.mega_pr passes (weight 3). Cap from line_count signal = 25.
    const config = configWithOnly("size.line_count", "size.mega_pr");
    const signals = {
      "size.line_count": { failed: true, scoreCap: 25 },
      "size.mega_pr": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(25);
  });

  it("takes the lowest cap when multiple failed signals set one", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: true, scoreCap: 50 },
      "size.line_count": { failed: true, scoreCap: 25 },
    };
    expect(computeScore(signals, config).score).toBe(0); // raw 0%, cap 25 — min wins
  });

  it("does not apply scoreCap from a passing signal", () => {
    const config = configWithOnly("size.file_count", "size.line_count");
    const signals = {
      "size.file_count": { failed: false, scoreCap: 10 },
      "size.line_count": { failed: false },
    };
    expect(computeScore(signals, config).score).toBe(100);
  });
});
