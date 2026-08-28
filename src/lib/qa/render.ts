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

/** Cap the standing-check list. Past this the board is the place to look. */
const MAX_LISTED = 40;

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

/**
 * The badge appended to a line. Short and shouty on purpose: this sits at the
 * end of a manifest line somebody is scanning, not reading.
 */
const BADGE: Record<QaStatus, string> = {
  QA_PENDING: "PENDING QA",
  QA_IN_REVIEW: "IN QA",
  QA_PASSED: "PASSED QA",
  QA_FAILED: "FAILED QA",
  QA_SKIPPED: "SKIPPED QA",
};

/**
 * Keep a note to one line, and short. A failure note is free text a reviewer
 * typed, so it can contain newlines, markers and markdown that would break the
 * block it sits in.
 */
function oneLine(note: string | null, max = 120): string {
  const clean = (note ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length === 0) return "";
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

/** How an item names itself where there is no manifest line to lean on. */
function label(item: QaRenderItem): string {
  if (item.prNumber == null) return item.title;
  const by = item.authorLogin ? ` by @${item.authorLogin}` : "";
  // GitHub expands `#123` into the PR title, so we do not repeat it.
  return `#${item.prNumber}${by}`;
}

/** What gets appended to one manifest line. */
export type QaAnnotation = {
  /** Already wrapped in bold and parentheses. */
  badge: string;
  /** Only carried for a failure, where the reason is the actionable part. */
  note: string | null;
};

export function qaSuffix(annotation: QaAnnotation): string {
  return annotation.note
    ? ` ${annotation.badge}: ${annotation.note}`
    : ` ${annotation.badge}`;
}

/**
 * QA state per PR, for the manifest to append.
 *
 * The status belongs on the line that already names the PR. Printing a second
 * list of the same seventeen PRs to add one word to each is noise, and it is
 * the version of this that shipped first.
 */
export function qaAnnotations(
  items: QaRenderItem[],
): Map<number, QaAnnotation> {
  const out = new Map<number, QaAnnotation>();
  for (const item of items) {
    if (item.droppedAt || item.prNumber == null) continue;
    const status = parseQaStatus(item.qaStatus);
    out.set(item.prNumber, {
      badge: `**(${BADGE[status]})**`,
      note: status === "QA_FAILED" ? oneLine(item.qaNotes) || null : null,
    });
  }
  return out;
}

/**
 * The headline. Deliberately blunt about failures: a batch that is 16 of 17
 * with one failure is not "nearly done", it is blocked.
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
  if (counts.failed > 0) parts.push(`**${counts.failed} failed**`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return `${parts.join(", ")}.`;
}

/**
 * The QA section: the headline, plus the standing checks.
 *
 * PRs are deliberately absent. They are badged in place in the manifest above,
 * where they are already listed. Standing checks have no manifest line of their
 * own, so this is the only place they can appear.
 */
export function renderQaLines(items: QaRenderItem[]): string[] {
  const live = items.filter((i) => !i.droppedAt);
  if (live.length === 0) return [];

  const lines = [qaHeadline(items)];

  const checks = live
    .filter((i) => i.prNumber == null)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (checks.length > 0) {
    lines.push("");
    for (const check of checks.slice(0, MAX_LISTED)) {
      const status = parseQaStatus(check.qaStatus);
      const note =
        status === "QA_FAILED" ? oneLine(check.qaNotes) : "";
      lines.push(
        `- ${check.title} **(${BADGE[status]})**${note ? `: ${note}` : ""}`,
      );
    }
    if (checks.length > MAX_LISTED) {
      lines.push(`- ...and ${checks.length - MAX_LISTED} more`);
    }
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
