/**
 * The guard's decision, as one pure function.
 *
 * Everything the check, the comment and the label do is a rendering of the
 * verdict this returns, and it does no I/O, exactly as `buildDecisionCheckPayload`
 * does not. The orchestrator in `run.ts` gathers the inputs and applies the
 * outputs; every rule about what blocks a PR lives here where a test can reach
 * it without a webhook.
 */

import { matchesAnyPattern } from "@/lib/applications/decide-pr";
import type { ResolvedGuardConfig } from "@/lib/guard/config";
import {
  unlockCovers,
  type GuardApprovedFiles,
  type GuardHit,
} from "@/lib/guard/match";

/** Who signed off, and by which route. */
export type GuardUnlock = {
  source: "review" | "label";
  by: string;
};

/** A review reduced to the one thing the guard asks of it. */
export type GuardReview = {
  login: string;
  /** GitHub's review state, uppercased. */
  state: string;
};

export type GuardNotApplicableReason =
  | { kind: "base"; baseRef: string; defaultBranch: string }
  | { kind: "no_rules" };

export type GuardVerdict =
  /** The guard has no say here, but the check is published anyway. */
  | { kind: "not_applicable"; reason: GuardNotApplicableReason }
  /** Nothing guarded was touched. */
  | { kind: "clear" }
  /** Guarded files, and a sign-off that covers them. */
  | { kind: "unlocked"; hits: GuardHit[]; unlocks: GuardUnlock[] }
  /** Guarded files, and no sign-off. */
  | {
      kind: "blocked";
      hits: GuardHit[];
      /** Which half of a `both` unlock is still outstanding, or "any" when
       * either route would do. */
      missing: "any" | "review" | "label";
      approvers: string[];
      unlockLabel: string;
    }
  /** The diff is bigger than we are willing to read, so we cannot answer. */
  | { kind: "undecidable"; reason: "diff_too_large" };

export type GuardEvaluateInput = {
  cfg: ResolvedGuardConfig;
  /** True when the PR's base is the repo's default branch. */
  baseIsDefault: boolean;
  baseRef: string;
  defaultBranch: string;
  /** Guarded files in the current diff. */
  hits: GuardHit[];
  /** The file list we classified was cut short, so `hits` may be incomplete. */
  filesTruncated: boolean;
  /**
   * Current review state per user, or null when we deliberately did not ask.
   * Null and `[]` mean different things: `[]` is "nobody has approved", null is
   * "we did not look because the stored unlock already answered".
   */
  reviews: GuardReview[] | null;
  /**
   * A recorded label unlock, with the approver who applied it. Read from our
   * own record rather than from the label being present on the PR: only an
   * application we witnessed, from a login on the approver list, counts.
   */
  labelUnlockBy: string | null;
  /** `PrCheck.guardApprovedFiles`, the previously signed-off blob SHAs. */
  approvedFiles: GuardApprovedFiles;
  /** Who recorded that snapshot, and how. */
  priorUnlock: GuardUnlock | null;
};

/**
 * Decide, in the order the plan spells out. The first answer wins.
 *
 * The truncation check sits *after* the base and rule checks and *before*
 * everything else: a diff we could not read whole says nothing about a PR that
 * is not aimed at the default branch anyway, but once the guard does apply, not
 * having seen the whole diff has to outrank "the files we did see look fine".
 * Passing because we stopped looking is the one failure mode a guard cannot
 * have.
 */
export function evaluateGuard(input: GuardEvaluateInput): GuardVerdict {
  const { cfg } = input;

  if (!cfg.enabled) {
    return { kind: "not_applicable", reason: { kind: "no_rules" } };
  }

  if (!input.baseIsDefault) {
    return {
      kind: "not_applicable",
      reason: {
        kind: "base",
        baseRef: input.baseRef,
        defaultBranch: input.defaultBranch,
      },
    };
  }

  if (input.filesTruncated) {
    return { kind: "undecidable", reason: "diff_too_large" };
  }

  if (input.hits.length === 0) return { kind: "clear" };

  // A stored sign-off that still covers every guarded blob is the cheap path:
  // it is why the common case costs no reviews call.
  const covered = unlockCovers(input.hits, input.approvedFiles);
  const carried: GuardUnlock[] =
    covered && input.priorUnlock ? [input.priorUnlock] : [];

  const reviewApprover = findReviewApprover(input.reviews, cfg.approvers);
  const labelApprover =
    input.labelUnlockBy && isApprover(input.labelUnlockBy, cfg.approvers)
      ? input.labelUnlockBy
      : null;

  const live: GuardUnlock[] = [];
  if (reviewApprover) live.push({ source: "review", by: reviewApprover });
  if (labelApprover) live.push({ source: "label", by: labelApprover });

  if (cfg.unlockMode === "both") {
    // Both signals required. A carried snapshot alone is not enough: it records
    // that the files were signed off, not that both routes still say so.
    if (reviewApprover && labelApprover) {
      return { kind: "unlocked", hits: input.hits, unlocks: live };
    }
    return {
      kind: "blocked",
      hits: input.hits,
      missing: reviewApprover ? "label" : "review",
      approvers: cfg.approvers,
      unlockLabel: cfg.unlockLabel,
    };
  }

  if (live.length > 0) {
    return { kind: "unlocked", hits: input.hits, unlocks: live };
  }
  // No live signal, but a snapshot covering this exact diff means somebody
  // approved it and GitHub has since stopped reporting the review (dismissed on
  // push, or we did not fetch reviews at all). Honour the snapshot: it is our
  // own record of a sign-off on these very blobs.
  if (carried.length > 0) {
    return { kind: "unlocked", hits: input.hits, unlocks: carried };
  }

  return {
    kind: "blocked",
    hits: input.hits,
    missing: "any",
    approvers: cfg.approvers,
    unlockLabel: cfg.unlockLabel,
  };
}

function isApprover(login: string, approvers: string[]): boolean {
  return matchesAnyPattern(login, approvers);
}

/**
 * The first configured approver whose current review state is APPROVED.
 *
 * `reviews` is already reduced to one effective state per user by
 * `listPullRequestReviews`, so a reviewer who approved and then requested
 * changes does not count, and neither does a dismissed approval.
 */
function findReviewApprover(
  reviews: GuardReview[] | null,
  approvers: string[],
): string | null {
  if (!reviews) return null;
  for (const review of reviews) {
    if (review.state !== "APPROVED") continue;
    if (isApprover(review.login, approvers)) return review.login;
  }
  return null;
}

/**
 * Does this verdict let the PR through?
 *
 * One place, because the check conclusion, the label and the comment all have
 * to agree: a green check next to a "blocked" label is worse than either alone.
 */
export function guardPasses(verdict: GuardVerdict): boolean {
  return (
    verdict.kind === "not_applicable" ||
    verdict.kind === "clear" ||
    verdict.kind === "unlocked"
  );
}
