import { describe, expect, it } from "vitest";
import {
  applyBatchBlock,
  renderBatchBlock,
  selectBatchEntries,
} from "@/lib/github/staging";
import type { PrSummary } from "@/lib/github/pr-actions";

function pr(overrides: Partial<PrSummary> & { number: number }): PrSummary {
  return {
    title: `PR ${overrides.number}`,
    state: "open",
    merged: false,
    mergedAt: null,
    body: null,
    baseRef: "staging",
    headRef: `feature-${overrides.number}`,
    authorLogin: "octocat",
    labels: [],
    ...overrides,
  };
}

describe("renderBatchBlock", () => {
  it("renders one line per PR in the agreed format", () => {
    const block = renderBatchBlock([
      { number: 123, title: "Fix the retry backoff", author: "octocat" },
      { number: 124, title: "Add German translations", author: "hubot" },
    ]);
    expect(block).toContain("- Fix the retry backoff (#123 by @octocat)");
    expect(block).toContain("- Add German translations (#124 by @hubot)");
  });

  it("falls back to the PR number when a title is blank", () => {
    const block = renderBatchBlock([
      { number: 7, title: "   ", author: "octocat" },
    ]);
    expect(block).toContain("- PR #7 (#7 by @octocat)");
  });

  it("omits the author when GitHub gave us none", () => {
    const block = renderBatchBlock([{ number: 7, title: "Thing", author: null }]);
    expect(block).toContain("- Thing (#7)");
  });

  it("says so when the batch is empty rather than rendering an empty list", () => {
    expect(renderBatchBlock([])).toContain("Nothing in this batch yet");
  });
});

describe("applyBatchBlock", () => {
  const block = renderBatchBlock([
    { number: 1, title: "One", author: "a" },
  ]);

  it("uses the block as the whole body when there is no body", () => {
    expect(applyBatchBlock(null, block)).toBe(block);
    expect(applyBatchBlock("   \n", block)).toBe(block);
  });

  it("appends to a body that has no markers yet", () => {
    const out = applyBatchBlock("Ship it on Friday.", block);
    expect(out.startsWith("Ship it on Friday.")).toBe(true);
    expect(out).toContain(block);
  });

  it("preserves human text above and below the markers", () => {
    const first = applyBatchBlock("Preamble.", block);
    const withNote = `${first}\n\nRemember to bump the changelog.`;
    const next = renderBatchBlock([
      { number: 1, title: "One", author: "a" },
      { number: 2, title: "Two", author: "b" },
    ]);
    const out = applyBatchBlock(withNote, next);
    expect(out.startsWith("Preamble.")).toBe(true);
    expect(out).toContain("Remember to bump the changelog.");
    expect(out).toContain("- Two (#2 by @b)");
    // The stale single-entry list is gone, not duplicated.
    expect(out.match(/### In this batch/g)).toHaveLength(1);
  });

  it("is a no-op when the rendered block is unchanged", () => {
    const body = applyBatchBlock("Preamble.", block);
    expect(applyBatchBlock(body, block)).toBe(body);
  });
});

describe("selectBatchEntries", () => {
  const stagingBranch = "staging";

  it("keeps open PRs based on staging and drops other bases", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1 }), pr({ number: 2, baseRef: "main" })],
      stagingBranch,
      since: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it("drops PRs closed without merging", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1, state: "closed", merged: false })],
      stagingBranch,
      since: null,
      excludePrNumber: null,
    });
    expect(entries).toEqual([]);
  });

  it("excludes PRs merged before the previous batch shipped", () => {
    const since = new Date("2026-08-10T00:00:00Z");
    const entries = selectBatchEntries({
      prs: [
        pr({
          number: 1,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
        pr({
          number: 2,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-12T00:00:00Z",
        }),
      ],
      stagingBranch,
      since,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([2]);
  });

  it("includes every merged PR when no batch has shipped yet", () => {
    const entries = selectBatchEntries({
      prs: [
        pr({
          number: 1,
          state: "closed",
          merged: true,
          mergedAt: "2026-08-01T00:00:00Z",
        }),
      ],
      stagingBranch,
      since: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it("never lists the aggregate PR inside its own manifest", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1 }), pr({ number: 99 })],
      stagingBranch,
      since: null,
      excludePrNumber: 99,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it("sorts by PR number so the body is stable across reconciles", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 9 }), pr({ number: 3 }), pr({ number: 5 })],
      stagingBranch,
      since: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([3, 5, 9]);
  });
});
