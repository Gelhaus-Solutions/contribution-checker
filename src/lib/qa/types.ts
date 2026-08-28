/**
 * QA state for one item in a staging batch.
 *
 * The manifest in the aggregate PR body answers "what ships in this release".
 * This answers the question that actually gates the merge: has anyone exercised
 * it? On a thirty-PR batch with four testers, that state lives in a Slack thread
 * or in nobody's head, and the failure mode is silent: the release merges with
 * an unverified PR in it.
 *
 * Kept free of imports so it can be read from workflow code, from pure render
 * helpers and from the client bundle alike.
 */

/**
 * The five states an item can be in.
 *
 * Prefixed rather than reusing the bare `PENDING` / `APPROVED` / `DENIED`
 * strings on purpose: those are already claimed by the application lifecycle in
 * `src/lib/ui/status.ts`, where `PENDING` renders as "Not applied". Sharing them
 * would make a QA item read as an application verdict on every page that uses
 * the shared status map.
 */
export const QA_STATUSES = [
  "QA_PENDING",
  "QA_IN_REVIEW",
  "QA_PASSED",
  "QA_FAILED",
  "QA_SKIPPED",
] as const;

export type QaStatus = (typeof QA_STATUSES)[number];

const KNOWN_STATUSES = new Set<string>(QA_STATUSES);

export function isQaStatus(value: string): value is QaStatus {
  return KNOWN_STATUSES.has(value);
}

/**
 * Tolerant read of the stored column. A row written by a future version, or by
 * hand, reads as pending rather than crashing a page: an unknown state is
 * exactly as unverified as no state.
 */
export function parseQaStatus(raw: string | null | undefined): QaStatus {
  return raw && isQaStatus(raw) ? raw : "QA_PENDING";
}

/**
 * Resolved means "somebody made a decision about this", not "it passed".
 * `QA_SKIPPED` counts: deciding a docs-only change needs no verification is a
 * verdict, and a batch full of them is finished, not outstanding.
 */
export function isResolved(status: QaStatus): boolean {
  return (
    status === "QA_PASSED" || status === "QA_FAILED" || status === "QA_SKIPPED"
  );
}

/** One item's QA state, reduced to what the summaries read. */
export type QaCountable = {
  qaStatus: QaStatus;
  droppedAt?: Date | null;
};

export type QaCounts = {
  total: number;
  pending: number;
  inReview: number;
  passed: number;
  failed: number;
  skipped: number;
  /** passed + failed + skipped. */
  resolved: number;
};

/**
 * Count a batch. Dropped items are excluded from every figure: they are no
 * longer shipping, so counting them would leave a batch permanently short of
 * complete for work that is not in it.
 */
export function countQa(items: QaCountable[]): QaCounts {
  const live = items.filter((i) => !i.droppedAt);
  const by = (s: QaStatus) => live.filter((i) => i.qaStatus === s).length;
  const passed = by("QA_PASSED");
  const failed = by("QA_FAILED");
  const skipped = by("QA_SKIPPED");
  return {
    total: live.length,
    pending: by("QA_PENDING"),
    inReview: by("QA_IN_REVIEW"),
    passed,
    failed,
    skipped,
    resolved: passed + failed + skipped,
  };
}

/**
 * A batch is green when every live item is resolved and none failed. An empty
 * batch is **not** green: there is nothing to ship, so calling it verified would
 * publish a success check for a release that does not exist.
 */
export function isGreen(counts: QaCounts): boolean {
  return counts.total > 0 && counts.resolved === counts.total && counts.failed === 0;
}
