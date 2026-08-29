import { describe, expect, it } from "vitest";
import { authoredText, hasAuthoredContent } from "@/lib/ai/prefilter";
import { qaStepsTask } from "@/lib/ai/tasks/qa-steps";
import { prQualityTask } from "@/lib/ai/tasks/pr-quality";

/** A realistic unfilled PR template, of the kind most repos ship. */
const UNFILLED = `## Description

<!-- Describe your changes in detail -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change

## Checklist

- [ ] I have added tests
- [ ] I have updated the documentation

---
Please make sure you have read the contributing guide.`;

const FILLED = `## Description

Sessions were expiring 24h after issue rather than 24h after last use, so
active users were being logged out mid-task.

## Type of change

- [x] Bug fix
- [ ] New feature

## Checklist

- [x] I have added tests`;

describe("hasAuthoredContent", () => {
  it("sees nothing in an unfilled template", () => {
    expect(hasAuthoredContent(UNFILLED)).toBe(false);
  });

  it("sees the prose in a filled one", () => {
    expect(hasAuthoredContent(FILLED)).toBe(true);
    expect(authoredText(FILLED)).toContain("logged out mid-task");
  });

  it("treats an empty or missing body as nothing", () => {
    expect(hasAuthoredContent(null)).toBe(false);
    expect(hasAuthoredContent("")).toBe(false);
    expect(hasAuthoredContent("   \n\n  ")).toBe(false);
  });

  it("counts a ticked box as a deliberate act, an unticked one as scaffolding", () => {
    expect(hasAuthoredContent("- [ ] Bug fix\n- [ ] Feature")).toBe(false);
    expect(hasAuthoredContent("- [x] Bug fix")).toBe(true);
    expect(authoredText("- [x] Bug fix")).toBe("Bug fix");
  });

  it("ignores headings, rules and HTML comments", () => {
    expect(hasAuthoredContent("## Description\n\n---\n\n<!-- write here -->")).toBe(false);
  });

  it("keeps a fenced code block, which nobody pastes by accident", () => {
    expect(hasAuthoredContent("## Repro\n\n```\nnpm run build\n```")).toBe(true);
  });

  it("drops a multi-line HTML comment wrapping guidance prose", () => {
    const body = "## Why\n<!--\nExplain why this change is needed.\nLink any related issues.\n-->";
    expect(hasAuthoredContent(body)).toBe(false);
  });

  it("drops common filler answers", () => {
    expect(hasAuthoredContent("## Notes\n\nN/A")).toBe(false);
    expect(hasAuthoredContent("## Notes\n\nTBD")).toBe(false);
  });

  it("strips guidance but keeps the author's words in the same body", () => {
    const mixed = "## Description\n\ne.g. a short summary\n\nFixes the retry backoff overflow.";
    const text = authoredText(mixed);
    expect(text).toBe("Fixes the retry backoff overflow.");
  });
});

const files = [
  { filename: "src/auth.ts", status: "modified", additions: 40, deletions: 12 },
];

describe("prefilter wiring", () => {
  it("qa steps makes no call when the template was never filled in", () => {
    // The only lever that actually saves money on this deployment: prompt
    // caching does not fire, so the saving has to be the call not happening.
    expect(
      qaStepsTask.buildInput({
        title: "Update thing",
        body: UNFILLED,
        authorQaSteps: null,
        files,
        labels: [],
      })
    ).toBeNull();
  });

  it("qa steps still runs when the author wrote something", () => {
    expect(
      qaStepsTask.buildInput({
        title: "Fix session expiry",
        body: FILLED,
        authorQaSteps: null,
        files,
        labels: [],
      })
    ).not.toBeNull();
  });

  it("qa steps sends the cleaned description, not the scaffolding", () => {
    const built = qaStepsTask.buildInput({
      title: "Fix session expiry",
      body: FILLED,
      authorQaSteps: null,
      files,
      labels: [],
    });
    expect(built).toContain("logged out mid-task");
    expect(built).not.toContain("I have updated the documentation");
    expect(built).not.toContain("## Description");
  });

  it("pr quality deliberately still runs on an unfilled template", () => {
    // "The author wrote nothing" is the finding this task exists to report.
    // Skipping would exempt the very worst descriptions from the heuristic that
    // judges descriptions.
    const built = prQualityTask.buildInput({
      title: "chore: cleanup",
      body: UNFILLED,
      files,
      commitMessages: [],
    });
    expect(built).not.toBeNull();
    expect(built).toContain("none written, or an unfilled template");
  });
});
