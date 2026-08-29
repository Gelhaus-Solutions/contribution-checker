import { describe, expect, it } from "vitest";
import { qaStepsTask } from "@/lib/ai/tasks/qa-steps";
import { applyTaskChanges, parseTasksInBody } from "@/lib/qa/tasks";

const files = [
  { filename: "src/api/login.ts", status: "modified", additions: 40, deletions: 12 },
  { filename: "src/api/login.test.ts", status: "added", additions: 90, deletions: 0 },
];

const base = {
  title: "Fix session expiry on login",
  body: "Sessions were expiring after 5 minutes instead of 24 hours.",
  authorQaSteps: null,
  files,
  labels: ["bug"],
};

describe("qaStepsTask prefilter", () => {
  it("does not call the model when the author wrote QA steps", () => {
    // The single largest saving in the subsystem: on a typical batch this is
    // most of the PRs that carry any QA information at all.
    expect(
      qaStepsTask.buildInput({ ...base, authorQaSteps: "- [ ] log in\n- [ ] wait" })
    ).toBeNull();
  });

  it("treats whitespace-only author steps as absent", () => {
    expect(qaStepsTask.buildInput({ ...base, authorQaSteps: "   \n  " })).not.toBeNull();
  });

  it("skips a PR with no changed files", () => {
    expect(qaStepsTask.buildInput({ ...base, files: [] })).toBeNull();
  });

  it("includes title, labels, description and changed files", () => {
    const built = qaStepsTask.buildInput(base);
    expect(built).toContain("Fix session expiry");
    expect(built).toContain("bug");
    expect(built).toContain("expiring after 5 minutes");
    expect(built).toContain("src/api/login.ts");
    expect(built).toContain("+40/-12");
  });

  it("skips entirely when there is no description to work from", () => {
    // Changed deliberately: with no QA section and no description, the only
    // input left is a title and a file list, which is not enough to write a
    // test plan worth reading. Skipping is the only lever that saves money on
    // this deployment, since prompt caching does not fire (see prefilter.ts).
    expect(qaStepsTask.buildInput({ ...base, body: null })).toBeNull();
    expect(qaStepsTask.buildInput({ ...base, body: "" })).toBeNull();
  });

  it("caps the file list rather than sending an unbounded diff", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 1,
    }));
    const built = qaStepsTask.buildInput({ ...base, files: many }) ?? "";
    expect(built).toContain("and 140 more files");
    expect(built).not.toContain("src/f199.ts");
  });
});

describe("qaStepsTask output contract", () => {
  const valid = {
    summary: "Extends the session lifetime to 24 hours.",
    steps: ["Log in", "Wait 10 minutes", "Confirm you are still signed in"],
    unknowns: [],
  };

  it("requires at least one step", () => {
    expect(qaStepsTask.parse({ ...valid, steps: [] })).toBeNull();
    expect(qaStepsTask.parse(valid)).not.toBeNull();
  });

  it("rejects a response missing a field", () => {
    expect(qaStepsTask.parse({ summary: "s", steps: ["a"] })).toBeNull();
  });
});

describe("generated-step ticks stay local", () => {
  /**
   * Two checklists now exist side by side and they persist in different places:
   * author steps tick by rewriting the PR description on GitHub, generated steps
   * tick into AiResult.tickedSteps. Crossing the wires would either write our
   * text onto somebody's pull request or silently drop every tick.
   */
  it("ticking a generated step must not be expressible as a body edit", () => {
    const body = ["## QA", "- [ ] Log in as an admin"].join("\n");
    const generated = [
      "Start the app in a staging environment",
      "Open the analytics page and check no 5.0% badge appears",
    ];
    // Index 1 exists in the generated list but not in the body's task list.
    const res = applyTaskChanges({
      body,
      changes: [{ index: 1, expectedText: generated[1], checked: true }],
    });
    expect(res.ok).toBe(false);
    expect(parseTasksInBody(body).every((t) => !t.checked)).toBe(true);
  });
});

describe("generated steps never reach the PR body editor", () => {
  /**
   * The failure this guards against is quiet and bad: pointing the checkbox
   * editor at generated text means matching `expectedText` against lines that do
   * not exist in the description. Every tick would fail, and on a body that
   * happened to have a QA section it could tick the wrong line entirely.
   */
  it("does not match generated steps against a real PR body", () => {
    const body = [
      "## QA",
      "- [ ] Log in as an admin",
      "- [ ] Check the audit log",
    ].join("\n");

    const generated = ["Log in", "Wait 10 minutes", "Confirm you are still signed in"];

    const res = applyTaskChanges({
      body,
      changes: generated.map((text, index) => ({
        index,
        expectedText: text,
        checked: true,
      })),
    });

    // Refused whole, not half-applied.
    expect(res.ok).toBe(false);
    expect(parseTasksInBody(body).every((t) => !t.checked)).toBe(true);
  });

  it("the author's real steps still tick correctly, proving the guard is specific", () => {
    const body = ["## QA", "- [ ] Log in as an admin"].join("\n");
    const res = applyTaskChanges({
      body,
      changes: [{ index: 0, expectedText: "Log in as an admin", checked: true }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body).toContain("- [x] Log in as an admin");
  });
});
