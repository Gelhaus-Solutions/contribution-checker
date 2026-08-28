import { z } from "zod";
import { clamp } from "@/lib/ai/prompt";
import type { AiTask } from "@/lib/ai/types";

/**
 * The "what to watch when this goes out" note for a staging batch.
 *
 * `buildStagingDigest` already answers the countable questions: which
 * environment variables the batch adds or drops, which migrations it carries,
 * which commits are marked breaking, how big the diff is. Those are facts and
 * they belong in the release PR body, deterministic and unchanging.
 *
 * What they cannot say is how the pieces interact: that a migration and an
 * environment variable arrived together and therefore have an ordering, or that
 * three separate PRs all touched the same subsystem. That is the gap here.
 *
 * This is the only task on the judgment tier. It reads more input than the
 * others and is the only one making a genuine synthesis rather than a
 * classification, and it runs about once per release rather than per PR, so the
 * better model costs very little in total.
 *
 * Renders on the dashboard only. It is deliberately NOT written into the
 * aggregate PR body: that body is diffed before it is PATCHed, and every
 * reconcile compares the rendered block against what is already there. Model
 * output is not stable across runs, so putting it inside the staging-batch
 * markers would turn every push into a visible edit on the release PR and
 * notify everybody watching it. The manifest's determinism is worth more than
 * having the paragraph in two places.
 */

/** A batch with nothing in it has nothing to narrate. */
const MIN_PRS = 2;
const MAX_PR_LINES = 60;
const MAX_DIGEST_CHARS = 4000;

const output = z.object({
  narrative: z.string().min(1).max(1500),
  watchFor: z.array(z.string().min(1).max(300)).max(6),
  /** The model's read on how risky this release is to ship. Advisory. */
  risk: z.enum(["ROUTINE", "ELEVATED", "HIGH"]),
});

export type ReleaseNarrativeOutput = z.infer<typeof output>;

export type ReleaseNarrativeInput = {
  prs: Array<{ number: number; title: string; author: string | null }>;
  /** Rendered deterministic digest lines, the factual half. */
  digestLines: string[];
  stats: { files: number; additions: number; deletions: number; commits: number };
};

export const releaseNarrativeTask: AiTask<
  ReleaseNarrativeInput,
  ReleaseNarrativeOutput
> = {
  id: "batch.release_narrative",
  label: "Release narrative",
  description:
    "Summarises what a staging batch ships and what to watch when it goes out. Shown on the QA board only, never written into the release pull request.",
  tier: "judgment",
  promptVersion: 1,
  defaultEnabled: false,

  system: [
    "Task: brief a release manager about to ship a batch of merged pull",
    "requests to production.",
    "",
    "You are given the pull requests in the batch and a factual digest already",
    "computed from the diff: environment variables added or removed, database",
    "migrations, dependency and CI changes, commits marked as breaking, and",
    "diff statistics.",
    "",
    "Do not restate the digest. The reader has it directly above your text, and",
    "repeating it wastes the only thing you add. Your job is what the digest",
    "cannot say: how the pieces relate to each other, which changes have to",
    "happen in a particular order, and where two unrelated-looking PRs touch the",
    "same area.",
    "",
    "Field meanings:",
    "- narrative: a short paragraph, three or four sentences, describing what",
    "  this release does as a whole. Group related PRs rather than listing them.",
    "- watchFor: specific things that could go wrong on deploy, each tied to",
    "  something in the input. A migration plus a new environment variable is",
    "  worth a line; a typo fix is not. Empty is a fine answer for a quiet",
    "  release, and better than invented risk.",
    "- risk: ROUTINE, ELEVATED or HIGH. Judge deployment risk only, not code",
    "  quality. Schema migrations, new required configuration and breaking",
    "  changes raise it. Volume alone does not: forty documentation PRs are",
    "  routine.",
    "",
    "You cannot see the code, only titles and the digest, so do not claim to",
    "know what an implementation does. Say what the evidence supports.",
  ].join("\n"),

  jsonSchema: {
    type: "object",
    properties: {
      narrative: { type: "string" },
      watchFor: { type: "array", items: { type: "string" } },
      risk: { type: "string", enum: ["ROUTINE", "ELEVATED", "HIGH"] },
    },
    required: ["narrative", "watchFor", "risk"],
    additionalProperties: false,
  },

  buildInput(batch) {
    // One or zero PRs is not a release to brief anyone about, and the manifest
    // already says everything there is to say.
    if (batch.prs.length < MIN_PRS) return null;

    const shown = batch.prs.slice(0, MAX_PR_LINES);
    const prLines = shown.map(
      (p) => `#${p.number} ${p.title}${p.author ? ` (by ${p.author})` : ""}`
    );
    if (batch.prs.length > shown.length) {
      prLines.push(`... and ${batch.prs.length - shown.length} more pull requests`);
    }

    const parts = [`Pull requests in this batch:\n${prLines.join("\n")}`];

    if (batch.digestLines.length > 0) {
      parts.push(
        `Computed digest:\n${clamp(batch.digestLines.join("\n"), MAX_DIGEST_CHARS)}`
      );
    }

    const { files, additions, deletions, commits } = batch.stats;
    parts.push(
      `Diff statistics: ${files} files changed, +${additions}/-${deletions} lines, ${commits} commits.`
    );

    return parts.join("\n\n");
  },

  parse(raw) {
    const r = output.safeParse(raw);
    return r.success ? r.data : null;
  },
};
