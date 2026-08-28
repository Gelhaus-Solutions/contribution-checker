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
});
