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
    mergeCommitSha: null,
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
      { number: 123, author: "octocat" },
      { number: 124, author: "hubot" },
    ]);
    expect(block).toContain("- #123 by @octocat");
    expect(block).toContain("- #124 by @hubot");
  });

  // The reference is deliberately bare: GitHub expands it to the PR title when
  // it renders, and carrying our own copy printed the title twice.
  it("carries no title of its own", () => {
    const block = renderBatchBlock([{ number: 123, author: "octocat" }]);
    expect(block).not.toMatch(/`/);
  });

  it("omits the author when GitHub gave us none", () => {
    const block = renderBatchBlock([{ number: 7, author: null }]);
    expect(block).toContain("- #7");
    expect(block).not.toContain("by @");
  });

  it("carries no automation footer", () => {
    const block = renderBatchBlock([{ number: 1, author: "a" }]);
    expect(block).not.toContain("Updated automatically");
  });

  it("says so when the batch is empty rather than rendering an empty list", () => {
    expect(renderBatchBlock([])).toContain("No merged PRs in this batch yet");
  });
});

describe("applyBatchBlock", () => {
  const block = renderBatchBlock([
    { number: 1, author: "a" },
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
      { number: 1, author: "a" },
      { number: 2, author: "b" },
    ]);
    const out = applyBatchBlock(withNote, next);
    expect(out.startsWith("Preamble.")).toBe(true);
    expect(out).toContain("Remember to bump the changelog.");
    expect(out).toContain("- #2 by @b");
    // The stale single-entry list is gone, not duplicated.
    expect(out.match(/### In this batch/g)).toHaveLength(1);
  });

  it("is a no-op when the rendered block is unchanged", () => {
    const body = applyBatchBlock("Preamble.", block);
    expect(applyBatchBlock(body, block)).toBe(body);
  });
});

/** A PR that actually landed on staging: the only kind the manifest lists. */
function merged(number: number, mergedAt = "2026-08-15T00:00:00Z"): PrSummary {
  return pr({ number, state: "closed", merged: true, mergedAt });
}

describe("selectBatchEntries", () => {
  const stagingBranch = "staging";

  it("lists merged PRs and drops other bases", () => {
    const entries = selectBatchEntries({
      prs: [merged(1), { ...merged(2), baseRef: "main" }],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it("drops open PRs: a proposal is not part of the batch", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1, state: "open" }), merged(2)],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([2]);
  });

  it("drops PRs closed without merging", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1, state: "closed", merged: false })],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries).toEqual([]);
  });

  it("is empty when staging only moved via direct pushes", () => {
    const entries = selectBatchEntries({
      prs: [pr({ number: 1, state: "open" })],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries).toEqual([]);
  });

  it("excludes PRs merged before the previous batch shipped", () => {
    const entries = selectBatchEntries({
      prs: [merged(1, "2026-08-01T00:00:00Z"), merged(2, "2026-08-12T00:00:00Z")],
      stagingBranch,
      since: new Date("2026-08-10T00:00:00Z"),
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([2]);
  });

  it("includes every merged PR when no batch has shipped yet", () => {
    const entries = selectBatchEntries({
      prs: [merged(1, "2026-08-01T00:00:00Z")],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  it("never lists the aggregate PR inside its own manifest", () => {
    const entries = selectBatchEntries({
      prs: [merged(1), merged(99)],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: 99,
    });
    expect(entries.map((e) => e.number)).toEqual([1]);
  });

  // The regression that emptied gitroomhq/postiz-app#1902. Syncing the default
  // branch into staging makes the merge base the default branch's tip, whose
  // date is "just now", so every PR merged into staging earlier fell outside a
  // `mergedAt > mergeBaseDate` cutoff and the manifest rendered empty. Merge
  // commit reachability is the question that was actually being asked.
  it("keeps PRs merged long before the merge base when their commit is in the batch", () => {
    const entries = selectBatchEntries({
      prs: [
        { ...merged(1, "2026-08-17T06:00:52Z"), mergeCommitSha: "aaa" },
        { ...merged(2, "2026-08-17T09:01:16Z"), mergeCommitSha: "bbb" },
      ],
      stagingBranch,
      // A sync merge that landed after both PRs merged.
      since: new Date("2026-08-17T10:17:55Z"),
      batchShas: new Set(["aaa", "bbb", "sync-merge"]),
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1, 2]);
  });

  // The real gitroomhq/postiz-app graph. #1897 merged feat/tiktok-business into
  // staging (merge commit d7acd5ac, head-side parent 306b6e94). The same branch
  // was then merged into main by #1908, so 306b6e94 is on main and outside the
  // batch: the staging merge commit ships nothing. #1901 and #1903 are ordinary
  // merges whose head-side parents are still staging-only.
  it("drops a merge whose content already reached the default branch", () => {
    const entries = selectBatchEntries({
      prs: [
        { ...merged(1897), mergeCommitSha: "d7acd5ac" },
        { ...merged(1901), mergeCommitSha: "b629fae7" },
        { ...merged(1903), mergeCommitSha: "409fe767" },
      ],
      stagingBranch,
      since: null,
      batchShas: new Set([
        "d7acd5ac",
        "b629fae7",
        "e6cc6341",
        "409fe767",
        "92b6b566",
      ]),
      batchParents: {
        // head-side parent 306b6e94 is on main, not in the batch
        "d7acd5ac": ["409fe767", "306b6e94"],
        "b629fae7": ["9ddbd73c", "e6cc6341"],
        "409fe767": ["b629fae7", "92b6b566"],
      },
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([1901, 1903]);
  });

  it("keeps a squash or rebase merge, whose commit is itself the content", () => {
    const entries = selectBatchEntries({
      prs: [{ ...merged(5), mergeCommitSha: "squashed" }],
      stagingBranch,
      since: null,
      batchShas: new Set(["squashed"]),
      batchParents: { squashed: ["staging-tip"] },
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([5]);
  });

  it("drops a PR whose merge commit already shipped in an earlier batch", () => {
    const entries = selectBatchEntries({
      prs: [
        { ...merged(1), mergeCommitSha: "shipped" },
        { ...merged(2), mergeCommitSha: "pending" },
      ],
      stagingBranch,
      since: null,
      batchShas: new Set(["pending"]),
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([2]);
  });

  it("falls back to the timestamp when a PR has no recorded merge commit", () => {
    const entries = selectBatchEntries({
      prs: [
        { ...merged(1, "2026-08-01T00:00:00Z"), mergeCommitSha: null },
        { ...merged(2, "2026-08-12T00:00:00Z"), mergeCommitSha: null },
      ],
      stagingBranch,
      since: new Date("2026-08-10T00:00:00Z"),
      batchShas: new Set(["something-else"]),
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([2]);
  });

  it("sorts by PR number so the body is stable across reconciles", () => {
    const entries = selectBatchEntries({
      prs: [merged(9), merged(3), merged(5)],
      stagingBranch,
      since: null,
      batchShas: null,
      batchParents: null,
      excludePrNumber: null,
    });
    expect(entries.map((e) => e.number)).toEqual([3, 5, 9]);
  });
});
