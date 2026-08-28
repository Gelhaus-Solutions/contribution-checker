import { describe, expect, it } from "vitest";
import {
  applyTaskChanges,
  parseTaskLines,
  parseTasksInBody,
  taskProgress,
} from "@/lib/qa/tasks";
import { extractQaSteps } from "@/lib/qa/extract";

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

describe("parseTasksInBody", () => {
  it("reads the QA section's tasks and their state", () => {
    expect(parseTasksInBody(BODY)).toEqual([
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
    expect(parseTasksInBody(BODY).some((t) => t.text.includes("CONTRIBUTING"))).toBe(
      false,
    );
  });

  it.each([
    ["* [ ] star bullet", "star bullet"],
    ["+ [ ] plus bullet", "plus bullet"],
    ["  - [ ] indented", "indented"],
    ["- [X] capital X", "capital X"],
  ])("accepts %s", (line, text) => {
    expect(parseTasksInBody(`## QA\n${line}`)[0].text).toBe(text);
  });

  it("ignores task lines inside a fenced code block", () => {
    const body = ["## QA", "```md", "- [ ] not real", "```", "- [ ] real"].join(
      "\n",
    );
    expect(parseTasksInBody(body)).toEqual([
      { index: 0, text: "real", checked: false },
    ]);
  });

  it.each([null, undefined, "", "no headings here", "## QA\njust prose"])(
    "returns nothing for %s",
    (body) => {
      expect(parseTasksInBody(body as string)).toEqual([]);
    },
  );
});

describe("taskProgress", () => {
  it("counts the ticked ones", () => {
    expect(taskProgress(parseTasksInBody(BODY))).toEqual({ done: 1, total: 3 });
  });
});

describe("parseTaskLines", () => {
  // The gap that shipped: `qaSteps` stores the section CONTENT with the heading
  // already stripped, so the body-scoped parser found no heading, returned
  // nothing, and the board silently degraded the checklist to read-only text.
  it("parses what extractQaSteps actually stores", () => {
    const stored = extractQaSteps(BODY);
    expect(stored).not.toBeNull();
    expect(parseTaskLines(stored)).toEqual(parseTasksInBody(BODY));
  });

  it.each([
    "# QA\n\n- [ ] one\n- [ ] two",
    "## Testing\n- [x] one\n- [ ] two",
    "### How to test\n\n- [ ] one\n- [ ] two\n",
  ])("round-trips through extraction (%#)", (body) => {
    expect(parseTaskLines(extractQaSteps(body))).toEqual(
      parseTasksInBody(body),
    );
  });

  it("takes every task line, having no section to scope to", () => {
    expect(parseTaskLines("- [ ] a\n- [x] b")).toEqual([
      { index: 0, text: "a", checked: false },
      { index: 1, text: "b", checked: true },
    ]);
  });

  it.each([null, undefined, "", "just prose"])("returns nothing for %s", (v) => {
    expect(parseTaskLines(v as string)).toEqual([]);
  });
});

describe("applyTaskChanges", () => {
  it("ticks a box and changes nothing else", () => {
    const result = applyTaskChanges({
      body: BODY,
      changes: [
        { index: 0, expectedText: "Verify Sentry initializes", checked: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.applied).toBe(1);
    const before = BODY.split("\n");
    const after = result.body.split("\n");
    expect(after).toHaveLength(before.length);
    // Everything else is byte-identical: this is somebody's PR description.
    expect(after.filter((l, i) => l !== before[i])).toEqual([
      "- [x] Verify Sentry initializes",
    ]);
  });

  it("writes a whole batch in one pass", () => {
    const result = applyTaskChanges({
      body: BODY,
      changes: [
        { index: 0, expectedText: "Verify Sentry initializes", checked: true },
        {
          index: 1,
          expectedText: "Verify Temporal activities send logs",
          checked: false,
        },
        {
          index: 2,
          expectedText:
            "Verify all normal console.log functions still submit logs to sentry",
          checked: true,
        },
      ],
    });
    expect(result.ok && result.applied).toBe(3);
    if (!result.ok) return;
    expect(taskProgress(parseTasksInBody(result.body))).toEqual({
      done: 2,
      total: 3,
    });
  });

  it("does not renumber itself as it edits", () => {
    // Indices are resolved against the original line map, so writing box 0
    // cannot shift what box 2 means.
    const result = applyTaskChanges({
      body: BODY,
      changes: [
        { index: 2, expectedText: "Verify all normal console.log functions still submit logs to sentry", checked: true },
        { index: 0, expectedText: "Verify Sentry initializes", checked: true },
      ],
    });
    expect(result.ok && result.applied).toBe(2);
  });

  it("preserves the bullet character and indentation", () => {
    const result = applyTaskChanges({
      body: "## QA\n  * [ ] indented star",
      changes: [{ index: 0, expectedText: "indented star", checked: true }],
    });
    expect(result.ok && result.body).toBe("## QA\n  * [x] indented star");
  });

  it("preserves CRLF line endings", () => {
    // Rejoining a CRLF body with LF would rewrite every line as a diff.
    const result = applyTaskChanges({
      body: "## QA\r\n- [ ] step one\r\n- [ ] step two",
      changes: [{ index: 0, expectedText: "step one", checked: true }],
    });
    expect(result.ok && result.body).toBe(
      "## QA\r\n- [x] step one\r\n- [ ] step two",
    );
  });

  it("refuses the whole batch when any step has moved", () => {
    // Half-applying is worse than not applying: the reviewer cannot tell which
    // half landed.
    const result = applyTaskChanges({
      body: BODY,
      changes: [
        { index: 0, expectedText: "Verify Sentry initializes", checked: true },
        { index: 1, expectedText: "Something else entirely", checked: true },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "text_moved" });
  });

  it("skips a change that is already in the desired state", () => {
    const result = applyTaskChanges({
      body: BODY,
      changes: [
        {
          index: 1,
          expectedText: "Verify Temporal activities send logs",
          checked: true,
        },
      ],
    });
    expect(result.ok && result.applied).toBe(0);
  });

  it("refuses a body with no QA section", () => {
    expect(
      applyTaskChanges({
        body: "## Notes\n- [ ] something",
        changes: [{ index: 0, expectedText: "something", checked: true }],
      }),
    ).toEqual({ ok: false, reason: "no_section" });
  });

  it("cannot reach the contributor checklist below the QA section", () => {
    // Index 3 would be the first checklist item if the span were not bounded.
    expect(
      applyTaskChanges({
        body: BODY,
        changes: [
          {
            index: 3,
            expectedText: "I have read the CONTRIBUTING guide.",
            checked: true,
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
