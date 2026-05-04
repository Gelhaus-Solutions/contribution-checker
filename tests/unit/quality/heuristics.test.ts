import { describe, expect, it } from "vitest";
import { ALL_HEURISTICS, HEURISTIC_BY_ID } from "@/lib/quality/registry";
import type { PrContext } from "@/lib/quality/types";

function ctx(partial: Partial<PrContext> = {}): PrContext {
  return {
    project: {
      id: "p1",
      qualityConfig: {},
      prTemplateHoneypots: [],
      templateMatchPct: 100,
    },
    pr: {
      number: 1,
      title: "Add a feature that does the thing properly",
      body: "Describes the change.",
      headSha: "abc",
      authorLogin: "alice",
    },
    prTemplate: null,
    files: [],
    filesTruncated: false,
    commits: [],
    account: { login: "alice" },
    ...partial,
  };
}

function get(id: string) {
  const h = HEURISTIC_BY_ID.get(id);
  if (!h) throw new Error(`unknown heuristic ${id}`);
  return h;
}

describe("size heuristics", () => {
  it("size.file_count fires above threshold", () => {
    const h = get("size.file_count");
    const c = ctx({
      files: Array.from({ length: 60 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        changes: 1,
      })),
    });
    expect(h.run(c, 50).failed).toBe(true);
    expect(h.run(c, 100).failed).toBe(false);
  });

  it("size.line_count uses additions+deletions", () => {
    const h = get("size.line_count");
    const c = ctx({
      files: [
        {
          filename: "a.ts",
          status: "modified",
          additions: 6000,
          deletions: 5000,
          changes: 11000,
        },
      ],
    });
    expect(h.run(c, 10000).failed).toBe(true);
  });

  it("size.trivial_patch fires for 1f/1L/1c with cap 50 by default", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      pr: {
        ...ctx().pr,
        title: "Fix a typo where Tracker had an extra letter",
        body: "This corrects a typo introduced in commit abc.",
      },
      files: [
        { filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 },
      ],
      commits: [{ sha: "abc", message: "fix typo" }],
    });
    const r = h.run(c, 3);
    expect(r.failed).toBe(true);
    expect(r.scoreCap).toBe(50);
  });

  it("size.trivial_patch caps at 25 when paired with empty body", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      pr: {
        ...ctx().pr,
        title: "Fix a typo where Tracker had an extra letter",
        body: "",
      },
      files: [
        { filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 },
      ],
      commits: [{ sha: "abc", message: "fix typo" }],
    });
    const r = h.run(c, 3);
    expect(r.failed).toBe(true);
    expect(r.scoreCap).toBe(25);
  });

  it("size.trivial_patch caps at 25 when paired with vague title", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      pr: {
        ...ctx().pr,
        title: "Update README.md",
        body: "This is a substantive description of the change being made.",
      },
      files: [
        { filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 },
      ],
      commits: [{ sha: "abc", message: "fix typo" }],
    });
    const r = h.run(c, 3);
    expect(r.failed).toBe(true);
    expect(r.scoreCap).toBe(25);
  });

  it("size.trivial_patch does not fire above the line threshold", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      files: [
        { filename: "a.ts", status: "modified", additions: 8, deletions: 2, changes: 10 },
      ],
      commits: [{ sha: "abc", message: "real change" }],
    });
    expect(h.run(c, 3).failed).toBe(false);
  });

  it("size.trivial_patch does not fire when more than one file is touched", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      files: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { filename: "b.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
      ],
      commits: [{ sha: "abc", message: "small" }],
    });
    expect(h.run(c, 3).failed).toBe(false);
  });

  it("size.trivial_patch does not fire when there are multiple commits", () => {
    const h = get("size.trivial_patch");
    const c = ctx({
      files: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
      ],
      commits: [
        { sha: "abc", message: "one" },
        { sha: "def", message: "two" },
      ],
    });
    expect(h.run(c, 3).failed).toBe(false);
  });
});

describe("PR text heuristics", () => {
  it("pr.body_empty fires only when whitespace-only", () => {
    const h = get("pr.body_empty");
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "   \n  " } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, body: "ok" } }), undefined).failed).toBe(false);
  });

  it("pr.title_vague flags short / generic titles", () => {
    const h = get("pr.title_vague");
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "fix" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "Update" } }), undefined).failed).toBe(true);
    expect(h.run(ctx({ pr: { ...ctx().pr, title: "🎉🎉🎉" } }), undefined).failed).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, title: "Add OAuth provider for SSO" } }), undefined).failed
    ).toBe(false);
  });

  it("pr.title_vague flags GitHub web-UI default titles", () => {
    const h = get("pr.title_vague");
    expect(
      h.run(ctx({ pr: { ...ctx().pr, title: "Update README.md" } }), undefined).failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, title: "Create foo.ts" } }), undefined).failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, title: "Delete legacy.md" } }), undefined).failed
    ).toBe(true);
    expect(
      h.run(
        ctx({ pr: { ...ctx().pr, title: "Update DB schema for users table" } }),
        undefined
      ).failed
    ).toBe(false);
  });

  it("pr.ai_watermark catches common AI phrases", () => {
    const h = get("pr.ai_watermark");
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "Here is the updated implementation." } }), undefined)
        .failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "As an AI language model I cannot..." } }), undefined)
        .failed
    ).toBe(true);
    expect(
      h.run(
        ctx({
          pr: {
            ...ctx().pr,
            body: "Some change.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
          },
        }),
        undefined
      ).failed
    ).toBe(true);
    expect(
      h.run(
        ctx({
          pr: {
            ...ctx().pr,
            body: "Some change.\n\nGenerated by [Codex](https://chatgpt.com/codex)",
          },
        }),
        undefined
      ).failed
    ).toBe(true);
    expect(
      h.run(ctx({ pr: { ...ctx().pr, body: "Refactored the queue to be lock-free." } }), undefined)
        .failed
    ).toBe(false);
  });

  it("pr.uses_template skips when the repo has no template", () => {
    const h = get("pr.uses_template");
    const r = h.run(ctx({ prTemplate: null }), undefined);
    expect(r.failed).toBe(false);
  });

  it("pr.uses_template fires when the body shows no template markers", () => {
    const h = get("pr.uses_template");
    const template = `## Description\n\n## Checklist\n- [ ] Tests added\n- [ ] Docs updated\n`;
    const r = h.run(
      ctx({
        prTemplate: template,
        pr: { ...ctx().pr, body: "Just a freeform note about the change." },
      }),
      undefined
    );
    expect(r.failed).toBe(true);
  });

  it("pr.uses_template passes when the body echoes a template marker", () => {
    const h = get("pr.uses_template");
    const template = `## Description\n\n## Checklist\n- [ ] Tests added\n`;
    const r = h.run(
      ctx({
        prTemplate: template,
        pr: {
          ...ctx().pr,
          body: "## Description\nAdds the new widget.\n\n## Checklist\n- [x] Tests added",
        },
      }),
      undefined
    );
    expect(r.failed).toBe(false);
  });

  it("pr.uses_template fires on empty body when a template exists", () => {
    const h = get("pr.uses_template");
    const r = h.run(
      ctx({
        prTemplate: "## Summary\n- [ ] Tested",
        pr: { ...ctx().pr, body: "" },
      }),
      undefined
    );
    expect(r.failed).toBe(true);
  });

  it("pr.uses_template fires when the template has checkboxes but the body has only headings", () => {
    const h = get("pr.uses_template");
    const template =
      "## What\nFoo\n## Why\nBar\n## Checklist\n- [ ] I read CONTRIBUTING\n- [ ] No AI used\n";
    const r = h.run(
      ctx({
        prTemplate: template,
        pr: {
          ...ctx().pr,
          body: "## What\nBug fix\n## Why\nFixes #1\n",
        },
      }),
      0
    );
    expect(r.failed).toBe(true);
  });

  it("pr.uses_template threshold lets admins allow N missing checkboxes", () => {
    const h = get("pr.uses_template");
    const template =
      "## Checklist\n- [ ] I read CONTRIBUTING\n- [ ] No AI used\n- [ ] Single concern\n";
    const body = "## Checklist\n- [x] I read CONTRIBUTING\n- [x] No AI used\n";
    const c = ctx({ prTemplate: template, pr: { ...ctx().pr, body } });
    expect(h.run(c, 0).failed).toBe(true);
    expect(h.run(c, 1).failed).toBe(false);
  });

  it("pr.uses_template falls back to heading match when template has no checkboxes", () => {
    const h = get("pr.uses_template");
    const template = "## Description\n\n## Why\n";
    expect(
      h.run(
        ctx({ prTemplate: template, pr: { ...ctx().pr, body: "## Description\nFoo" } }),
        0
      ).failed
    ).toBe(false);
    expect(
      h.run(
        ctx({ prTemplate: template, pr: { ...ctx().pr, body: "freeform note" } }),
        0
      ).failed
    ).toBe(true);
  });

  it("pr.template_extra_headers fires when body adds more headers than the admin allows", () => {
    const h = get("pr.template_extra_headers");
    const template =
      "# What kind of change does this PR introduce?\n\n# Why was this change needed?\n\n# Other information:\n\n# Checklist:\n- [ ] I read CONTRIBUTING\n";
    const body =
      "## What kind of change does this PR introduce?\nBug fix\n## Why was this change needed?\nFixes #1\n## What changes were made?\n- a\n## Key fix\n- b\n## Impact\n- c\n";
    const c = ctx({ prTemplate: template, pr: { ...ctx().pr, body } });
    // 3 extra headers: "what changes were made?", "key fix", "impact"
    expect(h.run(c, 0).failed).toBe(true);
    expect(h.run(c, 2).failed).toBe(true);
    expect(h.run(c, 3).failed).toBe(false);
  });

  it("pr.template_extra_headers skips when there's no template", () => {
    const h = get("pr.template_extra_headers");
    const r = h.run(
      ctx({
        prTemplate: null,
        pr: { ...ctx().pr, body: "## A\n## B\n## C\n" },
      }),
      0
    );
    expect(r.failed).toBe(false);
  });

  it("pr.template_extra_headers passes when body uses only template headings", () => {
    const h = get("pr.template_extra_headers");
    const template = "## Description\n## Why\n";
    const r = h.run(
      ctx({
        prTemplate: template,
        pr: { ...ctx().pr, body: "## Description\nFoo\n## Why\nBar\n" },
      }),
      0
    );
    expect(r.failed).toBe(false);
  });

  it("pr.honeypot_hit only fires when a configured honeypot string is in the body", () => {
    const h = get("pr.honeypot_hit");
    const c = ctx({
      project: {
        id: "p1",
        qualityConfig: {},
        prTemplateHoneypots: ["bait-token-xyz"],
        templateMatchPct: 100,
      },
      pr: { ...ctx().pr, body: "Notes... bait-token-xyz" },
    });
    expect(h.run(c, undefined).failed).toBe(true);
    expect(
      h.run({ ...c, pr: { ...c.pr, body: "no honeypot here" } }, undefined).failed
    ).toBe(false);
  });
});

describe("code heuristics", () => {
  it("code.lockfile_only fires when only lockfiles changed", () => {
    const h = get("code.lockfile_only");
    expect(
      h.run(
        ctx({
          files: [
            {
              filename: "pnpm-lock.yaml",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
        }),
        undefined
      ).failed
    ).toBe(true);
    expect(
      h.run(
        ctx({
          files: [
            {
              filename: "src/foo.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
        }),
        undefined
      ).failed
    ).toBe(false);
  });

  it("code.test_to_code_ratio fires when source is added without tests", () => {
    const h = get("code.test_to_code_ratio");
    const noTests = ctx({
      files: [
        { filename: "src/feat.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
      ],
    });
    expect(h.run(noTests, undefined).failed).toBe(true);
    const withTests = ctx({
      files: [
        { filename: "src/feat.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
        {
          filename: "tests/unit/feat.test.ts",
          status: "added",
          additions: 12,
          deletions: 0,
          changes: 12,
        },
      ],
    });
    expect(h.run(withTests, undefined).failed).toBe(false);
  });
});

describe("registry sanity", () => {
  it("every heuristic has a unique id", () => {
    const ids = ALL_HEURISTICS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every heuristic has a positive integer weight 1..4", () => {
    for (const h of ALL_HEURISTICS) {
      expect([1, 2, 3, 4]).toContain(h.weight);
    }
  });
});
