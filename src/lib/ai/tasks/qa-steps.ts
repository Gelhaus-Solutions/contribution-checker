import { z } from "zod";
import { clamp } from "@/lib/ai/prompt";
import type { AiTask } from "@/lib/ai/types";

/**
 * Suggested QA steps for a merged PR in a staging batch.
 *
 * The gap this fills is concrete. `StagingBatchItem.qaSteps` comes from
 * `extractQaSteps`, which finds a `## QA` section in the PR body, and most
 * authors never write one. The board then shows a reviewer a title and nothing
 * else, and the reviewer either opens the PR and reads the diff or ticks the box
 * without really checking. Proposed steps are worth more than an empty section
 * even when they are only roughly right.
 *
 * Two rules make this safe to ship, and both are enforced outside this file:
 *
 *   - The result is never written into the contributor's PR body. It is stored
 *     in `AiResult` and joined at render, so a reconcile cannot clobber it and
 *     it cannot clobber a human's verdict.
 *   - It is never handed to `applyTaskChanges` in src/lib/qa/tasks.ts. That
 *     function rewrites real checkboxes in the real PR description, matching on
 *     `expectedText`; text that exists only in our database would never match,
 *     and pointing it there would mean every tick fails.
 *
 * The prefilter is the cost story: when the author *did* write a QA section,
 * `buildInput` returns null and no call is made. On a typical batch that is most
 * of the PRs that have any QA information at all, and the ones left are exactly
 * the ones worth spending on.
 */

/** A diff this small says nothing useful; the title already covers it. */
const MIN_FILES = 1;
/** Per-file budget for the changed-file list. */
const MAX_FILES = 60;
/** The PR body is the best signal here, so it gets the largest share. */
const MAX_BODY_CHARS = 4000;

const output = z.object({
  /** Plain-language description of what the change does. */
  summary: z.string().min(1).max(800),
  steps: z.array(z.string().min(1).max(300)).min(1).max(8),
  /** What the model could not determine from the input. Honest gaps beat guesses. */
  unknowns: z.array(z.string().min(1).max(200)).max(4),
});

export type QaStepsOutput = z.infer<typeof output>;

export type QaStepsInput = {
  title: string;
  body: string | null;
  /** Null when the author wrote none. Non-null short-circuits the whole task. */
  authorQaSteps: string | null;
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  labels: string[];
};

export const qaStepsTask: AiTask<QaStepsInput, QaStepsOutput> = {
  id: "pr.qa_steps",
  label: "Suggested QA steps",
  description:
    "Proposes how to verify a merged PR when its author wrote no QA section. Shown on the QA board only, and never written back to the pull request.",
  tier: "cheap",
  promptVersion: 1,
  defaultEnabled: false,

  system: [
    "Task: propose how a reviewer should manually verify a merged pull request",
    "before it ships in a release.",
    "",
    "You are given the pull request title, its description, its labels and the",
    "list of files it changed with their line counts. You do not have the diff",
    "itself, so reason from filenames, the description and the change sizes.",
    "",
    "Field meanings:",
    "- summary: two or three sentences saying what the change does, in language",
    "  a reviewer who did not write it can act on.",
    "- steps: concrete things to do and observe, in order. Each step should be a",
    "  single action a person can carry out and a result they can check. Prefer",
    "  three good steps to eight vague ones. Do not invent URLs, command names,",
    "  environment variables or flags that do not appear in the input.",
    "- unknowns: things a reviewer will need that you could not determine, such",
    "  as which environment to test in or what the expected value is. Leave the",
    "  list empty rather than padding it.",
    "",
    "These are suggestions for a human, generated because the author wrote no",
    "test plan. Say plainly when the change is not manually verifiable at all",
    "(a refactor, a dependency bump, internal tooling) rather than inventing",
    "ceremony: one step saying the change is not user-visible and what to smoke",
    "test instead is a good answer.",
  ].join("\n"),

  jsonSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
      unknowns: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "steps", "unknowns"],
    additionalProperties: false,
  },

  buildInput(pr) {
    // The author already said how to test this. Their words beat ours, they are
    // already rendered on the board, and this is the single biggest saving in
    // the whole subsystem: on most batches it is most of the PRs.
    if (pr.authorQaSteps && pr.authorQaSteps.trim().length > 0) return null;
    if (pr.files.length < MIN_FILES) return null;

    const parts = [`Title: ${pr.title}`];
    if (pr.labels.length > 0) parts.push(`Labels: ${pr.labels.join(", ")}`);

    const body = pr.body?.trim();
    parts.push(
      body ? `Description:\n${clamp(body, MAX_BODY_CHARS)}` : "Description: (none written)"
    );

    const shown = pr.files.slice(0, MAX_FILES);
    const fileLines = shown.map(
      (f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`
    );
    if (pr.files.length > shown.length) {
      fileLines.push(`... and ${pr.files.length - shown.length} more files`);
    }
    parts.push(`Changed files:\n${fileLines.join("\n")}`);

    return parts.join("\n\n");
  },

  parse(raw) {
    const r = output.safeParse(raw);
    return r.success ? r.data : null;
  },
};
