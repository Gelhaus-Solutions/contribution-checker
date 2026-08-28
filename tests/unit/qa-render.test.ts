import { describe, expect, it } from "vitest";
import {
  buildQaCheckPayload,
  qaAnnotations,
  qaHeadline,
  renderQaLines,
  type QaRenderItem,
} from "@/lib/qa/render";
import { renderBatchBlock } from "@/lib/github/staging";

const BOARD = "https://cc.example/dashboard/projects/p1/qa";

function item(overrides: Partial<QaRenderItem> = {}): QaRenderItem {
  return {
    key: "pr:101",
    kind: "PR",
    prNumber: 101,
    title: "Add retries",
    authorLogin: "alice",
    qaStatus: "QA_PENDING",
    qaNotes: null,
    droppedAt: null,
    qaByLogin: null,
    qaByExternal: null,
    ...overrides,
  };
}

describe("qaAnnotations", () => {
  it("badges a pending PR", () => {
    const badges = qaAnnotations([item()]);
    expect(badges.get(101)).toEqual({ badge: "**(PENDING QA)**", note: null });
  });

  it.each([
    ["QA_PASSED", "**(PASSED QA)**"],
    ["QA_IN_REVIEW", "**(IN QA)**"],
    ["QA_SKIPPED", "**(SKIPPED QA)**"],
    ["QA_FAILED", "**(FAILED QA)**"],
  ])("badges %s as %s", (status, badge) => {
    expect(qaAnnotations([item({ qaStatus: status })]).get(101)?.badge).toBe(
      badge,
    );
  });

  it("carries the reason only for a failure, where it is the actionable part", () => {
    const failed = qaAnnotations([
      item({ qaStatus: "QA_FAILED", qaNotes: "checkout 500s on an empty cart" }),
    ]);
    expect(failed.get(101)?.note).toBe("checkout 500s on an empty cart");

    const passed = qaAnnotations([
      item({ qaStatus: "QA_PASSED", qaNotes: "looked fine" }),
    ]);
    expect(passed.get(101)?.note).toBeNull();
  });

  it("flattens a multi-line note so it cannot break the manifest line", () => {
    const badges = qaAnnotations([
      item({ qaStatus: "QA_FAILED", qaNotes: "line one\nline two" }),
    ]);
    expect(badges.get(101)?.note).toBe("line one line two");
  });

  it("strips comment markers out of a note", () => {
    // A note containing the block's own end marker would truncate the body.
    const badges = qaAnnotations([
      item({
        qaStatus: "QA_FAILED",
        qaNotes: "broke <!-- staging-batch:end --> here",
      }),
    ]);
    expect(badges.get(101)?.note).not.toContain("staging-batch:end");
  });

  it("skips dropped items and standing checks, which have no manifest line", () => {
    const badges = qaAnnotations([
      item({ droppedAt: new Date() }),
      item({ key: "standing:0:x", prNumber: null, title: "Sign-in works" }),
    ]);
    expect(badges.size).toBe(0);
  });
});

describe("renderQaLines", () => {
  it("renders nothing when there is nothing to verify", () => {
    expect(renderQaLines([])).toEqual([]);
  });

  it("renders nothing when every item has dropped out", () => {
    expect(renderQaLines([item({ droppedAt: new Date() })])).toEqual([]);
  });

  it("is just the headline when the batch is only PRs", () => {
    // The PRs are badged in the manifest above, so repeating them here would be
    // seventeen lines to add one word each.
    const lines = renderQaLines([
      item(),
      item({ key: "pr:102", prNumber: 102 }),
    ]);
    expect(lines).toEqual(["0 of 2 resolved."]);
  });

  it("lists standing checks, which have no manifest line of their own", () => {
    const lines = renderQaLines([
      item(),
      item({
        key: "standing:0:sign-in-works",
        kind: "CHECK",
        prNumber: null,
        title: "Sign-in works",
        authorLogin: null,
        qaStatus: "QA_PASSED",
      }),
    ]);
    expect(lines).toContain("- Sign-in works **(PASSED QA)**");
    expect(lines.some((l) => l.includes("#101"))).toBe(false);
  });

  it("gives a failed standing check its reason", () => {
    const lines = renderQaLines([
      item({
        key: "standing:0:checkout",
        kind: "CHECK",
        prNumber: null,
        title: "Checkout completes",
        authorLogin: null,
        qaStatus: "QA_FAILED",
        qaNotes: "card declined",
      }),
    ]);
    expect(lines).toContain(
      "- Checkout completes **(FAILED QA)**: card declined",
    );
  });

  it("renders byte-identically for the same state", () => {
    // The property that keeps a reconcile from editing the release PR for
    // nothing, and notifying everyone watching it.
    const items = [
      item({ qaStatus: "QA_PASSED" }),
      item({ key: "pr:102", prNumber: 102 }),
    ];
    expect(renderQaLines(items).join("\n")).toBe(
      renderQaLines([...items].reverse()).join("\n"),
    );
  });
});

describe("qaHeadline", () => {
  it("counts resolved against total", () => {
    expect(
      qaHeadline([
        item({ qaStatus: "QA_PASSED" }),
        item({ key: "pr:102", prNumber: 102 }),
      ]),
    ).toBe("1 of 2 resolved.");
  });

  it("calls out failures rather than burying them in a ratio", () => {
    expect(
      qaHeadline([
        item({ qaStatus: "QA_PASSED" }),
        item({ key: "pr:102", prNumber: 102, qaStatus: "QA_FAILED" }),
      ]),
    ).toBe("2 of 2 resolved, **1 failed**.");
  });

  it("says so when there is nothing to verify", () => {
    expect(qaHeadline([])).toBe("Nothing to verify yet.");
  });
});

describe("buildQaCheckPayload", () => {
  it("asks for action while items are outstanding", () => {
    const payload = buildQaCheckPayload({
      items: [item(), item({ key: "pr:102", prNumber: 102 })],
      boardUrl: BOARD,
    });
    // Not `failure`: nothing is broken, nobody has looked yet. A red X for
    // "not started" teaches people to ignore the check.
    expect(payload.conclusion).toBe("action_required");
    expect(payload.title).toBe("2 of 2 not yet verified");
  });

  it("fails when an item failed, and says which", () => {
    const payload = buildQaCheckPayload({
      items: [
        item({ qaStatus: "QA_PASSED" }),
        item({
          key: "pr:102",
          prNumber: 102,
          qaStatus: "QA_FAILED",
          qaNotes: "login loops",
        }),
      ],
      boardUrl: BOARD,
    });
    expect(payload.conclusion).toBe("failure");
    expect(payload.summary).toContain("#102");
    expect(payload.summary).toContain("login loops");
  });

  it("succeeds when everything is resolved", () => {
    const payload = buildQaCheckPayload({
      items: [
        item({ qaStatus: "QA_PASSED" }),
        item({ key: "pr:102", prNumber: 102, qaStatus: "QA_SKIPPED" }),
      ],
      boardUrl: BOARD,
    });
    expect(payload.conclusion).toBe("success");
    expect(payload.title).toBe("All 2 verified");
  });

  it("succeeds on an empty batch rather than blocking on an empty checklist", () => {
    expect(buildQaCheckPayload({ items: [], boardUrl: BOARD }).conclusion).toBe(
      "success",
    );
  });

  it("ignores dropped items", () => {
    const payload = buildQaCheckPayload({
      items: [
        item({ qaStatus: "QA_PASSED" }),
        item({ key: "pr:102", prNumber: 102, droppedAt: new Date() }),
      ],
      boardUrl: BOARD,
    });
    expect(payload.conclusion).toBe("success");
  });

  it("links the board so the check is actionable", () => {
    expect(
      buildQaCheckPayload({ items: [item()], boardUrl: BOARD }).summary,
    ).toContain(BOARD);
  });
});

describe("renderBatchBlock with QA", () => {
  const entries = [
    { number: 101, author: "alice", mergedAt: null },
    { number: 102, author: "carol", mergedAt: null },
  ];

  it("is unchanged when the project does not record QA", () => {
    expect(renderBatchBlock(entries)).toContain("- #101 by @alice\n");
    expect(renderBatchBlock(entries)).not.toContain("QA");
  });

  it("badges each manifest line in place", () => {
    const block = renderBatchBlock(entries, null, undefined, {
      badges: qaAnnotations([
        item({ qaStatus: "QA_PASSED" }),
        item({ key: "pr:102", prNumber: 102 }),
      ]),
      lines: ["1 of 2 resolved."],
    });
    expect(block).toContain("- #101 by @alice **(PASSED QA)**");
    expect(block).toContain("- #102 by @carol **(PENDING QA)**");
  });

  it("puts a failure reason on the line it belongs to", () => {
    const block = renderBatchBlock(entries, null, undefined, {
      badges: qaAnnotations([
        item({ qaStatus: "QA_FAILED", qaNotes: "checkout 500s" }),
      ]),
      lines: ["1 of 2 resolved, **1 failed**."],
    });
    expect(block).toContain("- #101 by @alice **(FAILED QA)**: checkout 500s");
  });

  it("does not repeat the PRs in the QA section", () => {
    const block = renderBatchBlock(entries, null, undefined, {
      badges: qaAnnotations([item(), item({ key: "pr:102", prNumber: 102 })]),
      lines: renderQaLines([item(), item({ key: "pr:102", prNumber: 102 })]),
    });
    // Each PR is named exactly once in the whole block.
    expect(block.split("#101")).toHaveLength(2);
    expect(block.split("#102")).toHaveLength(2);
  });

  it("omits the QA heading entirely when there are no lines", () => {
    expect(
      renderBatchBlock(entries, null, undefined, { lines: [] }),
    ).not.toContain("### QA");
  });

  it("keeps the QA section inside the markers the bot owns", () => {
    const block = renderBatchBlock(entries, null, undefined, {
      lines: ["1 of 2 resolved."],
    });
    expect(block.indexOf("### In this batch")).toBeLessThan(
      block.indexOf("### QA"),
    );
    // A human's preamble outside the markers survives.
    expect(block.indexOf("### QA")).toBeLessThan(
      block.indexOf("<!-- staging-batch:end -->"),
    );
  });
});
