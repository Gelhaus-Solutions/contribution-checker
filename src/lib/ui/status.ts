/**
 * Single source of truth for how a status string is presented.
 *
 * This replaces eight separate STATUS_VARIANT maps that had drifted apart:
 * four of them (the dashboard and application views) had no PENDING key at
 * all, so a pending applicant rendered in the neutral grey used for revoked
 * and superseded records, while the public project page rendered the same
 * status in amber. CHECK_REQUIRED was missing from every one of them even
 * though PrCheck.status stores it, so a CLA- or DCO-gated pull request fell
 * through to the default badge.
 *
 * Kept free of JSX so it runs under the existing vitest config, which is
 * environment: "node" and only collects tests/unit/ **.test.ts.
 */

export type StatusTone =
  | "default"
  | "secondary"
  | "success"
  | "warning"
  | "destructive"
  | "outline";

/**
 * Every status string this app renders, across applications, PR checks and
 * CLA records. Values are stored as plain strings (there are no Prisma enums),
 * so unknown input has to degrade rather than throw.
 */
const TONE: Record<string, StatusTone> = {
  // Application lifecycle, plus the derived PENDING the public page computes.
  PENDING: "warning",
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",

  // PR check outcomes.
  BYPASSED: "success",
  CHECK_REQUIRED: "warning",
  IGNORED: "secondary",

  // CLA corporate roster and version records.
  ACTIVE: "success",
  REVOKED: "secondary",
  DISPUTED: "destructive",
  SUPERSEDED: "secondary",

  // QA on a staging batch. Prefixed rather than reusing PENDING/APPROVED/DENIED
  // above: those are application verdicts, and PENDING already renders as
  // "Not applied", which is nonsense on a release checklist.
  QA_PENDING: "secondary",
  QA_IN_REVIEW: "warning",
  QA_PASSED: "success",
  QA_FAILED: "destructive",
  QA_SKIPPED: "outline",
};

/**
 * Human labels. Only listed where the raw enum value reads badly in a UI;
 * anything absent falls back to sentence case.
 */
const LABEL: Record<string, string> = {
  PENDING: "Not applied",
  SUBMITTED: "In review",
  CHECK_REQUIRED: "Check required",
  BYPASSED: "Bypassed",
  QA_PENDING: "Not verified",
  QA_IN_REVIEW: "Being verified",
  QA_PASSED: "Verified",
  QA_FAILED: "Failed",
  QA_SKIPPED: "Skipped",
};

export function statusTone(status: string): StatusTone {
  return TONE[status] ?? "secondary";
}

export function statusLabel(status: string): string {
  const known = LABEL[status];
  if (known) return known;
  // SCREAMING_SNAKE to Sentence case, so a status added to the database later
  // still renders readably instead of shouting.
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** True when the status is one this module recognises. */
export function isKnownStatus(status: string): boolean {
  return status in TONE;
}
