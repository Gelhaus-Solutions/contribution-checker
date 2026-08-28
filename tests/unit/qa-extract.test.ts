import { describe, expect, it } from "vitest";
import {
  extractLinkedIssues,
  extractQaSteps,
  extractSummary,
} from "@/lib/qa/extract";

describe("extractQaSteps", () => {
  it("reads a ## QA section", () => {
    const body = [
      "Adds a thing.",
      "",
      "## QA",
      "1. Sign in as an admin",
      "2. Open /settings",
      "",
      "## Notes",
      "unrelated",
    ].join("\n");
    expect(extractQaSteps(body)).toBe(
      "1. Sign in as an admin\n2. Open /settings",
    );
  });

  it.each([
    "## Testing",
    "### How to test",
    "## Test plan",
    "## Steps to verify",
    "#### Manual testing",
  ])("recognizes %s", (heading) => {
    expect(extractQaSteps(`${heading}\nclick the button`)).toBe(
      "click the button",
    );
  });

  it.each(["# QA", "## QA", "### QA", "###### QA", "  # QA"])(
    "accepts any heading level (%s)",
    (heading) => {
      expect(extractQaSteps(`${heading}\nclick the button`)).toBe(
        "click the button",
      );
    },
  );

  it("does not treat a hash with no space as a heading", () => {
    // `#QA` is not a heading in CommonMark, it is a line starting with a hash,
    // and treating it as one would swallow issue references like #QA-1.
    expect(extractQaSteps("#QA\nclick the button")).toBeNull();
  });

  it("is case and decoration insensitive", () => {
    expect(extractQaSteps("## **QA:**\nrun it")).toBe("run it");
  });

  it("does not match a heading that merely mentions testing", () => {
    expect(extractQaSteps("## Testing philosophy\nwe like tests")).toBeNull();
  });

  it("prefers an explicit qa comment over a heading", () => {
    const body = "<!-- qa: hit the health endpoint -->\n## QA\nfrom the heading";
    expect(extractQaSteps(body)).toBe("hit the health endpoint");
  });

  it("ignores a heading inside a fenced code block", () => {
    const body = ["```md", "## QA", "not real steps", "```"].join("\n");
    expect(extractQaSteps(body)).toBeNull();
  });

  it.each(["", "<!-- describe how to test -->", "- [ ]", "n/a", "TBD"])(
    "treats an unfilled template section (%s) as absent",
    (content) => {
      expect(extractQaSteps(`## QA\n${content}`)).toBeNull();
    },
  );

  it("returns null for a body with no QA section", () => {
    expect(extractQaSteps("Just a description.")).toBeNull();
  });

  it.each([null, undefined, ""])("handles %s", (body) => {
    expect(extractQaSteps(body)).toBeNull();
  });

  it("caps very long instructions", () => {
    const steps = extractQaSteps(`## QA\n${"x".repeat(3000)}`);
    expect(steps).toHaveLength(2003);
    expect(steps?.endsWith("...")).toBe(true);
  });
});

describe("extractLinkedIssues", () => {
  it.each([
    ["closes #12", [12]],
    ["Fixes #3", [3]],
    ["resolved #45", [45]],
    ["Closes: #7", [7]],
  ])("reads %s", (body, expected) => {
    expect(extractLinkedIssues(body)).toEqual(expected);
  });

  it("deduplicates and sorts, so the value is stable across reconciles", () => {
    expect(extractLinkedIssues("closes #9, fixes #2, resolves #9")).toEqual([
      2, 9,
    ]);
  });

  it("ignores a bare reference with no closing keyword", () => {
    expect(extractLinkedIssues("related to #12")).toEqual([]);
  });

  it("ignores closing keywords inside a code fence", () => {
    expect(extractLinkedIssues("```\ncloses #12\n```")).toEqual([]);
  });

  it("caps runaway lists", () => {
    const body = Array.from({ length: 30 }, (_, i) => `closes #${i + 1}`).join(
      "\n",
    );
    expect(extractLinkedIssues(body)).toHaveLength(10);
  });
});

describe("extractSummary", () => {
  it("takes the first real paragraph", () => {
    const body = "Adds a retry to the webhook sender.\n\nMore detail here.";
    expect(extractSummary(body)).toBe("Adds a retry to the webhook sender.");
  });

  it("joins a wrapped paragraph onto one line", () => {
    expect(extractSummary("Adds a retry\nto the sender.")).toBe(
      "Adds a retry to the sender.",
    );
  });

  it("skips template boilerplate before the description", () => {
    const body = [
      "<!-- Thanks for contributing! -->",
      "",
      "## Description",
      "",
      "Fixes the flaky login test.",
    ].join("\n");
    expect(extractSummary(body)).toBe("Fixes the flaky login test.");
  });

  it("skips a leading badge line", () => {
    expect(extractSummary("![badge](http://x/y.svg)\n\nReal text.")).toBe(
      "Real text.",
    );
  });

  it("strips inline markdown emphasis", () => {
    expect(extractSummary("Uses `fetch` and **retries** twice.")).toBe(
      "Uses fetch and retries twice.",
    );
  });

  it("returns null for a body that is only structure", () => {
    expect(extractSummary("## Checklist\n- [ ] tests\n- [ ] docs")).toBeNull();
  });

  it.each([null, undefined, ""])("handles %s", (body) => {
    expect(extractSummary(body)).toBeNull();
  });

  it.each([
    "eg: Bug fix, feature, docs update, ...",
    "e.g. a bug fix",
    "Please link to related issues when possible.",
    "Describe your changes here.",
    "Explain why this was needed.",
    "List any related issues.",
  ])("skips template guidance (%s)", (line) => {
    expect(extractSummary(line)).toBeNull();
  });
});

describe("a real PR template", () => {
  // The gitroomhq/postiz-app template, which defeated the first version of
  // extractSummary: every PR in the repo would have shown the same
  // "eg: Bug fix, feature, docs update" line as its summary.
  const TEMPLATE = [
    "### What kind of change does this PR introduce?",
    "",
    "eg: Bug fix, feature, docs update, ...",
    "",
    "### Why was this change needed?",
    "",
    "Please link to related issues when possible, and explain WHY you changed things, not WHAT you changed.",
    "",
    "### Other information:",
    "",
    "eg: Did you discuss this change with anybody before working on it?",
    "",
    "### QA",
    "",
    "1. Verify Sentry initiatives",
    "2. Verify Temporal activities send logs",
    "3. Verify all normal console.log functions still submit logs to sentry",
    "",
    "### Checklist:",
    "",
    'Put a "X" in the boxes below to indicate you have followed the checklist;',
    "",
    "- [ ] I have read the CONTRIBUTING guide.",
  ].join("\n");

  it("says nothing rather than quoting the template at the reviewer", () => {
    expect(extractSummary(TEMPLATE)).toBeNull();
  });

  it("still finds the QA steps the author actually wrote", () => {
    expect(extractQaSteps(TEMPLATE)).toBe(
      [
        "1. Verify Sentry initiatives",
        "2. Verify Temporal activities send logs",
        "3. Verify all normal console.log functions still submit logs to sentry",
      ].join("\n"),
    );
  });

  it("picks up a real description once the author fills one in", () => {
    const filled = TEMPLATE.replace(
      "eg: Bug fix, feature, docs update, ...",
      "Fixes the Sentry logging tags so console.log reaches Sentry.",
    );
    expect(extractSummary(filled)).toBe(
      "Fixes the Sentry logging tags so console.log reaches Sentry.",
    );
  });
});
