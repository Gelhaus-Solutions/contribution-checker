/**
 * Rendering a guard verdict: the Check Run payload and the PR comment.
 *
 * Pure, and deterministic for the same reason the staging digest must be: the
 * comment is compared against what is already on the PR before it is written,
 * so any instability turns every event into a visible edit and a notification
 * for everyone watching.
 */

import type { GuardVerdict, GuardUnlock } from "@/lib/guard/evaluate";
import type { GuardHit } from "@/lib/guard/match";

/** Matches `QaCheckPayload`: the publisher supplies the name and detailsUrl. */
export type GuardCheckPayload = {
  status: "completed";
  conclusion: "success" | "failure";
  title: string;
  summary: string;
};

/** How many guarded paths to name before collapsing into a count. A reviewer
 * who has to scroll has stopped reading. */
const MAX_LISTED = 15;

/** The HTML marker that identifies the bot's own guard comment, so it is edited
 * rather than reposted. Invisible in rendered markdown. */
export const GUARD_COMMENT_MARKER = "<!-- contribution-checker:guard -->";

export function buildGuardCheckPayload(
  verdict: GuardVerdict,
): GuardCheckPayload {
  switch (verdict.kind) {
    case "not_applicable":
      return {
        status: "completed",
        conclusion: "success",
        title: "Does not apply",
        summary:
          verdict.reason.kind === "base"
            ? `This PR targets \`${verdict.reason.baseRef}\`, not \`${verdict.reason.defaultBranch}\`. Guarded paths are only checked on PRs into the default branch.`
            : "This project guards no paths, so there is nothing to sign off.",
      };

    case "clear":
      return {
        status: "completed",
        conclusion: "success",
        title: "No guarded paths touched",
        summary:
          "None of the files changed by this PR are in a guarded path. No sign-off needed.",
      };

    case "unlocked":
      return {
        status: "completed",
        conclusion: "success",
        title: `Signed off by ${describeUnlocks(verdict.unlocks)}`,
        summary: [
          `${countPhrase(verdict.hits)} in this PR, and ${describeUnlocksLong(verdict.unlocks)}.`,
          "",
          ...renderHitLines(verdict.hits),
        ].join("\n"),
      };

    case "blocked":
      return {
        status: "completed",
        conclusion: "failure",
        title: `${countPhrase(verdict.hits)} awaiting sign-off`,
        summary: [
          `${countPhrase(verdict.hits)} in this PR:`,
          "",
          ...renderHitLines(verdict.hits),
          "",
          ...renderUnlockInstructions(verdict),
        ].join("\n"),
      };

    case "undecidable":
      return {
        status: "completed",
        conclusion: "failure",
        title: "Diff too large to verify",
        summary: [
          "This PR changes more files than the guard reads, so it cannot tell whether a guarded path is among them.",
          "",
          "It fails rather than passes: a guard that lets a change through because it stopped looking is worse than one that asks for an approval it did not strictly need. A sign-off clears it.",
        ].join("\n"),
      };
  }
}

/**
 * The same check, answered for a merge group rather than for one PR.
 *
 * A separate renderer because the wording of the PR verdicts is wrong here:
 * a queue's throwaway commit is not "this PR", it carries several, and the
 * detail belongs on each member's own check rather than repeated on a commit
 * nobody opens. What the queue needs from us is a conclusion and a list of
 * which members are holding it up.
 */
export type MergeGroupGuardState =
  | { kind: "not_applicable"; baseRef: string; defaultBranch: string }
  | { kind: "blocked"; prNumbers: number[] }
  | { kind: "clear" };

export function buildMergeGroupGuardPayload(
  state: MergeGroupGuardState,
): GuardCheckPayload {
  switch (state.kind) {
    case "not_applicable":
      return {
        status: "completed",
        conclusion: "success",
        title: "Does not apply",
        summary: `This merge group targets \`${state.baseRef}\`, not \`${state.defaultBranch}\`. Guarded paths are only checked on the default branch.`,
      };
    case "blocked": {
      const numbers = [...state.prNumbers].sort((a, b) => a - b);
      return {
        status: "completed",
        conclusion: "failure",
        title:
          numbers.length === 1
            ? "A PR in this group is awaiting sign-off"
            : `${numbers.length} PRs in this group are awaiting sign-off`,
        summary: [
          "This merge group carries work whose guarded paths have not been signed off:",
          "",
          ...numbers.map((n) => `- #${n}`),
          "",
          "Each of those PRs carries the detail on its own `contribution-checker / guard` check.",
        ].join("\n"),
      };
    }
    case "clear":
      return {
        status: "completed",
        conclusion: "success",
        title: "Signed off",
        summary:
          "Every PR in this merge group either touches no guarded path or has been signed off.",
      };
  }
}

/**
 * The comment, or null when there is nothing to say.
 *
 * Only a blocked or undecidable PR gets one. A passing guard says its piece in
 * the check and leaves the conversation alone; the caller deletes any comment it
 * previously left.
 */
export function buildGuardComment(verdict: GuardVerdict): string | null {
  if (verdict.kind === "undecidable") {
    return [
      GUARD_COMMENT_MARKER,
      "### Guarded paths: sign-off required",
      "",
      "This PR changes more files than the guard can read in one pass, so it cannot rule out a guarded path among them. It fails closed.",
      "",
      "A review approval from a maintainer clears it.",
    ].join("\n");
  }
  if (verdict.kind !== "blocked") return null;

  return [
    GUARD_COMMENT_MARKER,
    "### Guarded paths: sign-off required",
    "",
    `This PR changes ${countPhrase(verdict.hits).toLowerCase()} that a maintainer has to sign off before it can merge:`,
    "",
    ...renderHitLines(verdict.hits),
    "",
    ...renderUnlockInstructions(verdict),
    "",
    "Nothing is wrong with the change. The check is asking for a second pair of eyes on these files specifically.",
  ].join("\n");
}

// --- pieces ------------------------------------------------------------------

function countPhrase(hits: GuardHit[]): string {
  return hits.length === 1 ? "1 guarded file" : `${hits.length} guarded files`;
}

/** One bullet per path, grouped by what made it guarded, capped and sorted.
 * `hits` arrives sorted from `matchGuardedFiles`; the grouping preserves that. */
function renderHitLines(hits: GuardHit[]): string[] {
  const byReason = new Map<string, GuardHit[]>();
  for (const hit of hits) {
    const existing = byReason.get(hit.reason);
    if (existing) existing.push(hit);
    else byReason.set(hit.reason, [hit]);
  }
  const lines: string[] = [];
  let listed = 0;
  for (const reason of [...byReason.keys()].sort()) {
    const group = byReason.get(reason) ?? [];
    lines.push(`**${reason}**`);
    for (const hit of group) {
      if (listed >= MAX_LISTED) break;
      lines.push(`- \`${hit.path}\``);
      listed += 1;
    }
    if (listed >= MAX_LISTED) break;
  }
  if (hits.length > listed) {
    lines.push(`- ...and ${hits.length - listed} more`);
  }
  return lines;
}

function renderUnlockInstructions(
  verdict: Extract<GuardVerdict, { kind: "blocked" }>,
): string[] {
  const reviewLine =
    verdict.approvers.length > 0
      ? `- An approving review from ${formatList(verdict.approvers.map((a) => `\`${a}\``))}`
      : "- An approving review from a configured approver (this project has none set yet, so only the label can clear it)";
  const labelLine = `- The \`${verdict.unlockLabel}\` label, added by one of those people`;

  if (verdict.missing === "review") {
    return [
      "The label is on, and an approving review is still needed:",
      reviewLine,
    ];
  }
  if (verdict.missing === "label") {
    return ["The review is in, and the label is still needed:", labelLine];
  }
  return ["Either of these clears it:", reviewLine, labelLine];
}

function describeUnlocks(unlocks: GuardUnlock[]): string {
  const names = [...new Set(unlocks.map((u) => u.by))].sort();
  return formatList(names) || "a maintainer";
}

function describeUnlocksLong(unlocks: GuardUnlock[]): string {
  const parts = [...unlocks]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((u) =>
      u.source === "review"
        ? `\`${u.by}\` approved the PR`
        : `\`${u.by}\` added the unlock label`,
    );
  return formatList(parts) || "a maintainer signed off";
}

/** "a", "a and b", "a, b and c". */
function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
