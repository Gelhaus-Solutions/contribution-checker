import { z } from "zod";
import { clamp } from "@/lib/ai/prompt";
import type { AiTask } from "@/lib/ai/types";

/**
 * A model's read on whether a PR's description matches what it actually does.
 *
 * The deterministic heuristics in src/lib/quality/heuristics are good at
 * countable things: how many files, how long the body, whether the template was
 * filled in, whether the text carries AI watermark phrases. They cannot tell
 * whether a description is *true*. A PR titled "fix typo" that rewrites the auth
 * middleware passes every size and text heuristic ever written.
 *
 * That is the whole scope of this task, and it is why the output is one number
 * and one sentence. Anything broader (is this code good, should this merge) is
 * neither answerable from a diff summary nor something a gate should act on.
 *
 * Feeds `pr.ai_assessment` in the quality registry. The heuristic reads the
 * stored verdict off `PrContext` and never calls anything itself.
 */

/** Under this, the diff is too small to mismatch its description in any way that matters. */
const MIN_CHANGED_LINES = 20;
const MAX_BODY_CHARS = 3000;
const MAX_FILES = 50;

const output = z.object({
  /** 0-100, higher is better, matching the direction of the overall score. */
  assessment: z.number().int().min(0).max(100),
  reason: z.string().min(1).max(300),
  /** Set when the title or body describes something the file list contradicts. */
  descriptionMismatch: z.boolean(),
});

export type PrQualityOutput = z.infer<typeof output>;

export type PrQualityInput = {
  title: string;
  body: string | null;
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  commitMessages: string[];
};

export const prQualityTask: AiTask<PrQualityInput, PrQualityOutput> = {
  id: "pr.quality",
  label: "PR description assessment",
  description:
    "Judges whether a pull request's title and description match the change it actually makes. Feeds the PR quality score when enabled.",
  tier: "cheap",
  promptVersion: 1,
  defaultEnabled: false,

  system: [
    "Task: judge how well a pull request describes itself.",
    "",
    "You are given the title, description, commit messages and changed files",
    "with line counts. You do not have the diff, so reason from filenames,",
    "sizes and the words the author chose.",
    "",
    "Judge exactly one thing: does the description let a reviewer know what they",
    "are about to review? Do NOT judge whether the code is good, whether the",
    "change is a good idea, or whether it should be merged. You cannot see the",
    "code and those are not your call.",
    "",
    "Field meanings:",
    "- assessment: 0-100, where 100 means a reviewer could open this and know",
    "  exactly what changed and why, and 0 means the description tells them",
    "  nothing or actively misleads them. A short description for a small,",
    "  obvious change is fine and should score well: brevity is not a defect.",
    "- reason: one sentence saying what drove the score. Reference something",
    "  specific from the input.",
    "- descriptionMismatch: true only when the stated change and the file list",
    "  genuinely contradict each other, for example a 'documentation' change that",
    "  edits authentication code. Unrelated-looking files are common and normal",
    "  in real work, so reserve this for a real contradiction rather than",
    "  anything you find surprising.",
    "",
    "A missing description is a low score, not a mismatch.",
  ].join("\n"),

  jsonSchema: {
    type: "object",
    properties: {
      assessment: { type: "integer" },
      reason: { type: "string" },
      descriptionMismatch: { type: "boolean" },
    },
    required: ["assessment", "reason", "descriptionMismatch"],
    additionalProperties: false,
  },

  buildInput(pr) {
    const changed = pr.files.reduce((n, f) => n + f.additions + f.deletions, 0);
    // A three-line change cannot meaningfully misdescribe itself, and the
    // existing size heuristics already cover trivial PRs.
    if (changed < MIN_CHANGED_LINES) return null;

    const parts = [`Title: ${pr.title}`];
    const body = pr.body?.trim();
    parts.push(
      body ? `Description:\n${clamp(body, MAX_BODY_CHARS)}` : "Description: (none written)"
    );

    if (pr.commitMessages.length > 0) {
      // Subjects only: commit bodies repeat the PR description often enough that
      // sending them is mostly paying twice for the same words.
      const subjects = pr.commitMessages
        .map((m) => m.split("\n")[0])
        .slice(0, 20);
      parts.push(`Commit subjects:\n${subjects.join("\n")}`);
    }

    const shown = pr.files.slice(0, MAX_FILES);
    const lines = shown.map(
      (f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`
    );
    if (pr.files.length > shown.length) {
      lines.push(`... and ${pr.files.length - shown.length} more files`);
    }
    parts.push(`Changed files:\n${lines.join("\n")}`);

    return parts.join("\n\n");
  },

  parse(raw) {
    const r = output.safeParse(raw);
    return r.success ? r.data : null;
  },
};
