import { describe, expect, it } from "vitest";
import {
  buildQaCheckPayload,
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

describe("renderQaLines", () => {
  it("renders nothing when there is nothing to verify", () => {
    expect(renderQaLines([])).toEqual([]);
  });

  it("renders nothing when every item has dropped out", () => {
    expect(renderQaLines([item({ droppedAt: new Date() })])).toEqual([]);
  });

  it("names the verifier for a passed item", () => {
    const lines = renderQaLines([
      item({ qaStatus: "QA_PASSED", qaByLogin: "bob" }),
    ]);
    expect(lines).toContain("- #101 by @alice - verified by @bob");
  });

  it("carries the failure reason, which is the whole point of showing it here", () => {
    const lines = renderQaLines([
      item({
        qaStatus: "QA_FAILED",
        qaByLogin: "bob",
        qaNotes: "checkout 500s on an empty cart",
      }),
    ]);
    expect(lines).toContain(
      "- #101 by @alice - **FAILED** by @bob: checkout 500s on an empty cart",
    );
  });

  it("attributes a verdict that came from an external board", () => {
    const lines = renderQaLines([
      item({ qaStatus: "QA_PASSED", qaByExternal: "Dana (Notion)" }),
    ]);
    expect(lines).toContain("- #101 by @alice - verified by Dana (Notion)");
  });

  it("renders a standing check by its title, having no PR to link", () => {
    const lines = renderQaLines([
      item({
        key: "standing:0:sign-in-works",
        kind: "CHECK",
        prNumber: null,
        title: "Sign-in works",
        authorLogin: null,
        qaStatus: "QA_PASSED",
        qaByLogin: "bob",
      }),
    ]);
    expect(lines).toContain("- Sign-in works - verified by @bob");
  });

  it("flattens a multi-line note so it cannot break the block", () => {
    const lines = renderQaLines([
      item({ qaStatus: "QA_FAILED", qaNotes: "line one\nline two" }),
    ]);
    expect(lines.join("\n")).toContain("line one line two");
  });

  it("strips comment markers out of a note", () => {
    // A note containing the block's own end marker would truncate the body.
    const lines = renderQaLines([
      item({
        qaStatus: "QA_FAILED",
        qaNotes: "broke <!-- staging-batch:end --> here",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("staging-batch:end");
  });

  it("sorts by PR number, so the body is stable across reconciles", () => {
    const lines = renderQaLines([
      item({ key: "pr:120", prNumber: 120 }),
      item({ key: "pr:101", prNumber: 101 }),
      item({ key: "pr:110", prNumber: 110 }),
    ]);
    const numbers = lines
      .filter((l) => l.startsWith("- #"))
      .map((l) => Number(l.slice(3, 6)));
    expect(numbers).toEqual([101, 110, 120]);
  });

  it("renders byte-identically for the same state", () => {
    // The property that keeps a reconcile from editing the release PR for
    // nothing, and notifying everyone watching it.
    const items = [
      item({ qaStatus: "QA_PASSED", qaByLogin: "bob" }),
      item({ key: "pr:102", prNumber: 102 }),
    ];
    expect(renderQaLines(items).join("\n")).toBe(
      renderQaLines([...items].reverse()).join("\n"),
    );
  });

  it("caps a very long batch rather than printing hundreds of lines", () => {
    const many = Array.from({ length: 75 }, (_, i) =>
      item({ key: `pr:${i + 1}`, prNumber: i + 1 }),
    );
    const lines = renderQaLines(many);
    expect(lines).toContain("- ...and 15 more");
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
  const entries = [{ number: 101, author: "alice", mergedAt: null }];

  it("omits the QA heading entirely when there are no lines", () => {
    expect(renderBatchBlock(entries, null, undefined, [])).not.toContain("### QA");
  });

  it("appends the QA section after the manifest", () => {
    const block = renderBatchBlock(entries, null, undefined, [
      "1 of 1 resolved.",
      "",
      "- #101 by @alice - verified by @bob",
    ]);
    expect(block).toContain("### In this batch");
    expect(block).toContain("### QA");
    expect(block.indexOf("### In this batch")).toBeLessThan(
      block.indexOf("### QA"),
    );
    // Still inside the markers the bot owns, so a human's preamble survives.
    expect(block.indexOf("### QA")).toBeLessThan(
      block.indexOf("<!-- staging-batch:end -->"),
    );
  });
});
