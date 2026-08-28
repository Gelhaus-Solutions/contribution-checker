import { countQa, isGreen, parseQaStatus, type QaStatus } from "@/lib/qa/types";

/**
 * The QA section of the aggregate PR body, and the Check Run that mirrors it.
 *
 * Both are pure, so both are testable without Octokit, following the split
 * `buildDecisionCheckPayload` / `publishDecisionCheck` already uses.
 *
 * The PR body matters more than it looks: the person about to click merge is
 * standing on the release PR, not on the dashboard. If the answer to "has
 * anyone tested this?" is not on that page, it is not anywhere they will read
 * it in the ten seconds before they merge.
 *
 * Everything here must be deterministic. The body is PATCHed only when the
 * rendered text differs from what is there, so any instability (an unsorted
 * list, a timestamp, a count that jitters) turns every reconcile into a visible
 * edit on the release PR and a notification for everyone watching it.
 */

/** Cap the printed list. Past this the board is the right place to look. */
const MAX_LISTED = 60;

/** One item, reduced to what the renderers read. */
export type QaRenderItem = {
  key: string;
  kind: string;
  prNumber: number | null;
  title: string;
  authorLogin: string | null;
  qaStatus: string;
  qaNotes: string | null;
  droppedAt: Date | null;
  /** Local reviewer's GitHub login, when there is one. */
  qaByLogin?: string | null;
  /** Notion or Trello actor, when the verdict came from there. */
  qaByExternal?: string | null;
};

/** Who verified it, rendered for GitHub. */
function actor(item: QaRenderItem): string {
  if (item.qaByLogin) return `@${item.qaByLogin}`;
  if (item.qaByExternal) return item.qaByExternal;
  return "someone";
}

/**
 * Keep a note to one line. A failure note is free text a reviewer typed, so it
 * can contain newlines, markers and markdown that would break the block it sits
 * in.
 */
function oneLine(note: string | null, max = 160): string {
  const clean = (note ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length === 0) return "";
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

function label(item: QaRenderItem): string {
  if (item.prNumber != null) {
    const by = item.authorLogin ? ` by @${item.authorLogin}` : "";
    // GitHub expands `#123` into the PR title, so we do not repeat it.
    return `#${item.prNumber}${by}`;
  }
  return item.title;
}

function statusPhrase(item: QaRenderItem, status: QaStatus): string {
  switch (status) {
    case "QA_PASSED":
      return `verified by ${actor(item)}`;
    case "QA_FAILED": {
      const note = oneLine(item.qaNotes);
      const who = `**FAILED** by ${actor(item)}`;
      return note ? `${who}: ${note}` : who;
    }
    case "QA_SKIPPED": {
      const note = oneLine(item.qaNotes);
      const who = `skipped by ${actor(item)}`;
      return note ? `${who}: ${note}` : who;
    }
    case "QA_IN_REVIEW":
      return `being verified by ${actor(item)}`;
    default:
      return "not yet verified";
  }
}

/**
 * The headline. Deliberately blunt about failures: a batch that is 8 of 9 with
 * one failure is not "nearly done", it is blocked.
 */
export function qaHeadline(items: QaRenderItem[]): string {
  const counts = countQa(
    items.map((i) => ({
      qaStatus: parseQaStatus(i.qaStatus),
      droppedAt: i.droppedAt,
    })),
  );
  if (counts.total === 0) return "Nothing to verify yet.";
  const parts = [`${counts.resolved} of ${counts.total} resolved`];
  if (counts.failed > 0) {
    parts.push(`**${counts.failed} failed**`);
  }
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return `${parts.join(", ")}.`;
}

/**
 * Render the QA lines. Returns an empty array when there is nothing to say, so
 * the caller can omit the heading entirely rather than printing an empty
 * section on every quiet batch.
 */
export function renderQaLines(items: QaRenderItem[]): string[] {
  const live = items.filter((i) => !i.droppedAt);
  if (live.length === 0) return [];

  // Sorted by key, which is stable and matches the board: PR items ascend by
  // number because the key embeds it zero-free, so sort numerically where we
  // can and fall back to the key for standing checks.
  const sorted = [...live].sort((a, b) => {
    if (a.prNumber != null && b.prNumber != null) return a.prNumber - b.prNumber;
    if (a.prNumber != null) return -1;
    if (b.prNumber != null) return 1;
    return a.key.localeCompare(b.key);
  });

  const lines = [qaHeadline(items), ""];
  for (const item of sorted.slice(0, MAX_LISTED)) {
    const status = parseQaStatus(item.qaStatus);
    lines.push(`- ${label(item)} - ${statusPhrase(item, status)}`);
  }
  if (sorted.length > MAX_LISTED) {
    lines.push(`- ...and ${sorted.length - MAX_LISTED} more`);
  }
  return lines;
}

// --- Check Run ---------------------------------------------------------------

export type QaCheckPayload = {
  status: "completed";
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
};

/**
 * Map QA state onto a Check Run, so branch protection can hold a release that
 * nobody has verified.
 *
 * `action_required` rather than `failure` for outstanding work is the honest
 * mapping: nothing is broken, somebody just has not looked yet, and a red X for
 * "not started" trains people to ignore the check. A genuine failed item is a
 * `failure`, because something *is* broken.
 *
 * An empty batch is `success`: there is nothing to verify, and blocking a PR on
 * an empty checklist would be a gate that can never be satisfied.
 */
export function buildQaCheckPayload(args: {
  items: QaRenderItem[];
  boardUrl: string;
}): QaCheckPayload {
  const counts = countQa(
    args.items.map((i) => ({
      qaStatus: parseQaStatus(i.qaStatus),
      droppedAt: i.droppedAt,
    })),
  );
  const board = `\n\n[Open the QA board](${args.boardUrl})`;

  if (counts.total === 0) {
    return {
      status: "completed",
      conclusion: "success",
      title: "Nothing to verify",
      summary: `This batch has no items to verify.${board}`,
    };
  }

  if (counts.failed > 0) {
    const failed = args.items.filter(
      (i) => !i.droppedAt && parseQaStatus(i.qaStatus) === "QA_FAILED",
    );
    const detail = failed
      .slice(0, 10)
      .map((i) => {
        const note = oneLine(i.qaNotes, 120);
        return `- ${label(i)}${note ? `: ${note}` : ""}`;
      })
      .join("\n");
    return {
      status: "completed",
      conclusion: "failure",
      title: `${counts.failed} of ${counts.total} failed QA`,
      summary: `These items were verified and did not pass:\n\n${detail}${board}`,
    };
  }

  if (counts.resolved < counts.total) {
    const outstanding = counts.total - counts.resolved;
    return {
      status: "completed",
      conclusion: "action_required",
      title: `${outstanding} of ${counts.total} not yet verified`,
      summary:
        `${counts.resolved} of ${counts.total} items in this batch have been ` +
        `resolved. The rest still need somebody to verify them.${board}`,
    };
  }

  return {
    status: "completed",
    conclusion: "success",
    title: `All ${counts.total} verified`,
    summary:
      `Every item in this batch has been resolved and none failed.` +
      `${counts.skipped > 0 ? ` (${counts.skipped} skipped.)` : ""}${board}`,
  };
}

export { isGreen };
