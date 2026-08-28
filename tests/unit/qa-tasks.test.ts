import { describe, expect, it } from "vitest";
import {
  parseTasks,
  taskProgress,
  toggleTaskInBody,
} from "@/lib/qa/tasks";

const BODY = [
  "### What kind of change does this PR introduce?",
  "",
  "eg: Bug fix, feature, docs update, ...",
  "",
  "## QA",
  "",
  "- [ ] Verify Sentry initializes",
  "- [x] Verify Temporal activities send logs",
  "- [ ] Verify all normal console.log functions still submit logs to sentry",
  "",
  "### Checklist:",
  "",
  "- [ ] I have read the CONTRIBUTING guide.",
  "- [ ] I have signed the CLA.",
].join("\n");

describe("parseTasks", () => {
  it("reads the QA section's tasks and their state", () => {
    expect(parseTasks(BODY)).toEqual([
      { index: 0, text: "Verify Sentry initializes", checked: false },
      { index: 1, text: "Verify Temporal activities send logs", checked: true },
      {
        index: 2,
        text: "Verify all normal console.log functions still submit logs to sentry",
        checked: false,
      },
    ]);
  });

  it("stops at the next heading, so the contributor checklist is not QA", () => {
    // The template's own "I have read the CONTRIBUTING guide" is not something
    // a QA reviewer ticks off, and it must never be writable from the board.
    expect(parseTasks(BODY).some((t) => t.text.includes("CONTRIBUTING"))).toBe(
      false,
    );
  });

  it.each([
    ["* [ ] star bullet", "star bullet"],
    ["+ [ ] plus bullet", "plus bullet"],
    ["  - [ ] indented", "indented"],
    ["- [X] capital X", "capital X"],
  ])("accepts %s", (line, text) => {
    expect(parseTasks(`## QA\n${line}`)[0].text).toBe(text);
  });

  it("ignores task lines inside a fenced code block", () => {
    const body = ["## QA", "```md", "- [ ] not real", "```", "- [ ] real"].join(
      "\n",
    );
    expect(parseTasks(body)).toEqual([
      { index: 0, text: "real", checked: false },
    ]);
  });

  it.each([null, undefined, "", "no headings here", "## QA\njust prose"])(
    "returns nothing for %s",
    (body) => {
      expect(parseTasks(body as string)).toEqual([]);
    },
  );
});

describe("taskProgress", () => {
  it("counts the ticked ones", () => {
    expect(taskProgress(parseTasks(BODY))).toEqual({ done: 1, total: 3 });
  });
});

describe("toggleTaskInBody", () => {
  it("ticks a box and changes nothing else", () => {
    const result = toggleTaskInBody({
      body: BODY,
      index: 0,
      expectedText: "Verify Sentry initializes",
      checked: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body).toContain("- [x] Verify Sentry initializes");
    // Everything else is byte-identical: this is somebody's PR description.
    const before = BODY.split("\n");
    const after = result.body.split("\n");
    expect(after).toHaveLength(before.length);
    const differing = after.filter((l, i) => l !== before[i]);
    expect(differing).toEqual(["- [x] Verify Sentry initializes"]);
  });

  it("unticks a box", () => {
    const result = toggleTaskInBody({
      body: BODY,
      index: 1,
      expectedText: "Verify Temporal activities send logs",
      checked: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain("- [ ] Verify Temporal activities send logs");
  });

  it("preserves the bullet character and indentation", () => {
    const body = "## QA\n  * [ ] indented star";
    const result = toggleTaskInBody({
      body,
      index: 0,
      expectedText: "indented star",
      checked: true,
    });
    expect(result.ok && result.body).toBe("## QA\n  * [x] indented star");
  });

  it("preserves CRLF line endings", () => {
    // Rejoining a CRLF body with LF would rewrite every line as a diff.
    const body = "## QA\r\n- [ ] step one\r\n- [ ] step two";
    const result = toggleTaskInBody({
      body,
      index: 0,
      expectedText: "step one",
      checked: true,
    });
    expect(result.ok && result.body).toBe(
      "## QA\r\n- [x] step one\r\n- [ ] step two",
    );
  });

  it("refuses when the text at that index has moved", () => {
    // Somebody reordered or inserted a step since the board rendered. Ticking
    // by index alone would tick the wrong one.
    const result = toggleTaskInBody({
      body: BODY,
      index: 0,
      expectedText: "Verify something else entirely",
      checked: true,
    });
    expect(result).toEqual({ ok: false, reason: "text_moved" });
  });

  it("reports an unchanged toggle rather than writing", () => {
    const result = toggleTaskInBody({
      body: BODY,
      index: 1,
      expectedText: "Verify Temporal activities send logs",
      checked: true,
    });
    expect(result).toEqual({ ok: false, reason: "unchanged" });
  });

  it("refuses a body with no QA section", () => {
    expect(
      toggleTaskInBody({
        body: "## Notes\n- [ ] something",
        index: 0,
        expectedText: "something",
        checked: true,
      }),
    ).toEqual({ ok: false, reason: "no_section" });
  });

  it("refuses an index past the end", () => {
    expect(
      toggleTaskInBody({
        body: BODY,
        index: 9,
        expectedText: "whatever",
        checked: true,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("cannot reach the contributor checklist below the QA section", () => {
    // Index 3 would be the first checklist item if the span were not bounded.
    expect(
      toggleTaskInBody({
        body: BODY,
        index: 3,
        expectedText: "I have read the CONTRIBUTING guide.",
        checked: true,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("round-trips: parse, toggle, re-parse", () => {
    const result = toggleTaskInBody({
      body: BODY,
      index: 2,
      expectedText:
        "Verify all normal console.log functions still submit logs to sentry",
      checked: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskProgress(parseTasks(result.body))).toEqual({
      done: 2,
      total: 3,
    });
  });
});
