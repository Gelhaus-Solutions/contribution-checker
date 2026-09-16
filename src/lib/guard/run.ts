/**
 * The path guard's one impure entry point.
 *
 * Gathers the inputs, hands them to `evaluateGuard`, and applies the verdict:
 * the Check Run, the blocked marker label and the stored sign-off. Every
 * decision about what blocks a PR is in `evaluate.ts`; this file is the
 * plumbing around it.
 *
 * It deliberately posts NO pull request comment. The check's own summary already
 * carries the guarded paths and the way to clear them, and a bot paragraph
 * re-stating that on every contributor's PR is noise in a thread people still
 * have to read.
 *
 * Never throws. A guard that crashes the webhook handler would have GitHub
 * retrying the delivery forever, and the house rule is that PR side effects are
 * best-effort and logged.
 *
 * ## The cost model
 *
 * Every step that can answer without a GitHub call runs before one that cannot:
 *
 *  1. Config resolve and base check: database only. A repo with the guard off,
 *     or a PR aimed anywhere but the default branch, costs nothing extra.
 *  2. The file list: one call, for a guard-enabled project on a default-branch
 *     PR.
 *  3. The reviews: one more call, and ONLY when a guarded file was actually
 *     touched and the stored sign-off does not already cover the current blobs.
 *
 * So an ordinary contribution costs one request, and a PR sitting green on a
 * previous approval costs one. The reviews call is paid by the PRs that are
 * actually being gated, which is the small set.
 */

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { matchesAnyPattern } from "@/lib/applications/decide-pr";
import {
  addLabel,
  ensureLabel,
  listPullRequestFiles,
  listPullRequestReviews,
  removeLabelIfPresent,
  repoRef,
  type PrFileSummary,
} from "@/lib/github/pr-actions";
import { publishGuardCheck } from "@/lib/github/check-run";
import { resolveGuardConfig, guardProjectSelect } from "@/lib/guard/config";
import {
  evaluateGuard,
  guardPasses,
  type GuardUnlock,
  type GuardVerdict,
} from "@/lib/guard/evaluate";
import {
  matchGuardedFiles,
  parseApprovedFiles,
  serializeApprovedFiles,
  unlockCovers,
  type GuardHit,
} from "@/lib/guard/match";
import { buildGuardCheckPayload } from "@/lib/guard/render";

/**
 * How many pages of the file list to read before giving up and failing closed.
 *
 * Three pages is 300 files, the same ceiling `fetchPrContext` uses for quality
 * scoring. Past it the guard reports `undecidable` rather than passing: a guard
 * that lets a change through because it stopped looking is worse than one that
 * asks for an approval it did not strictly need.
 */
const FILE_PAGE_LIMIT = 3;

export type GuardRunResult = {
  /** Null when the guard did not run at all (disabled, or no repo row). */
  verdict: GuardVerdict | null;
};

const DID_NOT_RUN: GuardRunResult = { verdict: null };

/**
 * Evaluate and apply the guard for one PR.
 *
 * `labelJustAppliedBy` is set only on the `labeled` event that carried the
 * unlock label, and is how a label becomes trusted: the sign-off is recorded
 * from the sender we witnessed adding it, never re-derived from the label being
 * present. Otherwise anyone who could get the label onto a PR by any other route
 * would inherit an approver's authority.
 */
export async function runGuardForPr(args: {
  ghRepoId: number;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  headSha: string | null;
  baseRef: string | null;
  /** The login that just added the unlock label, if this event was that. */
  labelJustAppliedBy?: string | null;
  /** True when this event removed the unlock label. */
  labelJustRemoved?: boolean;
}): Promise<GuardRunResult> {
  try {
    return await runGuardInner(args);
  } catch (e) {
    logger.warn(
      { err: e, repoFullName: args.repoFullName, prNumber: args.prNumber },
      "runGuardForPr failed",
    );
    return DID_NOT_RUN;
  }
}

async function runGuardInner(args: {
  ghRepoId: number;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  headSha: string | null;
  baseRef: string | null;
  labelJustAppliedBy?: string | null;
  labelJustRemoved?: boolean;
}): Promise<GuardRunResult> {
  const repo = await prisma.repo.findUnique({
    where: { ghRepoId: args.ghRepoId },
    select: {
      id: true,
      active: true,
      defaultBranch: true,
      project: {
        select: { id: true, checksEnabled: true, ...guardProjectSelect },
      },
    },
  });
  if (!repo || !repo.active) return DID_NOT_RUN;

  const project = repo.project;
  const cfg = resolveGuardConfig(project);
  // Nothing configured to guard: publish no check at all rather than a green
  // one on every PR. That is the fourth state the other checks have, and it is
  // what keeps a project that never asked for this from seeing it.
  if (!cfg.enabled) return DID_NOT_RUN;

  const defaultBranch = repo.defaultBranch ?? "";
  const baseRef = args.baseRef ?? "";
  const baseIsDefault = !!defaultBranch && baseRef === defaultBranch;

  const prCheck = await prisma.prCheck.findUnique({
    where: { repoId_prNumber: { repoId: repo.id, prNumber: args.prNumber } },
    select: {
      id: true,
      guardUnlockSource: true,
      guardUnlockBy: true,
      guardApprovedFiles: true,
      guardLabelApplied: true,
    },
  });

  const ref = repoRef(args.repoFullName, args.installationId);

  // A label the bot did not witness an approver adding is worth nothing, and
  // one added by a non-approver is taken straight back off: leaving it there
  // would tell everyone reading the PR that it had been signed off.
  let labelUnlockBy: string | null =
    prCheck?.guardUnlockSource === "label" ? prCheck.guardUnlockBy : null;
  if (args.labelJustRemoved) {
    labelUnlockBy = null;
  } else if (args.labelJustAppliedBy) {
    if (matchesAnyPattern(args.labelJustAppliedBy, cfg.approvers)) {
      labelUnlockBy = args.labelJustAppliedBy;
    } else {
      labelUnlockBy = null;
      await removeLabelIfPresent(ref, args.prNumber, cfg.unlockLabel).catch(
        (e) =>
          logger.warn(
            { err: e, prNumber: args.prNumber },
            "guard: failed to remove label applied by a non-approver",
          ),
      );
      await recordAudit({
        projectId: project.id,
        actorId: null,
        kind: "guard.label_rejected",
        payload: {
          repoFullName: args.repoFullName,
          prNumber: args.prNumber,
          sender: args.labelJustAppliedBy,
          label: cfg.unlockLabel,
        },
      }).catch(() => undefined);
    }
  }

  // --- gather ---------------------------------------------------------------

  let hits: GuardHit[] = [];
  let filesTruncated = false;
  if (baseIsDefault) {
    const listed = await listPullRequestFiles(ref, args.prNumber, {
      pageLimit: FILE_PAGE_LIMIT,
    });
    // A 404 means the PR is gone. Nothing to guard and nothing to publish.
    if (!listed) return DID_NOT_RUN;
    filesTruncated = listed.truncated;
    hits = matchGuardedFiles(listed.files.map(toGuardFile), cfg);
  }

  const approvedFiles = parseApprovedFiles(prCheck?.guardApprovedFiles);
  const priorUnlock: GuardUnlock | null =
    prCheck?.guardUnlockSource === "review" ||
    prCheck?.guardUnlockSource === "label"
      ? { source: prCheck.guardUnlockSource, by: prCheck.guardUnlockBy ?? "" }
      : null;

  // The one conditional GitHub call. Skipped when nothing guarded was touched
  // (there is nothing to unlock) and when the stored sign-off already covers
  // every guarded blob, unless the project requires both signals, where the
  // review has to be confirmed live on every pass.
  let reviews = null as Awaited<
    ReturnType<typeof listPullRequestReviews>
  > | null;
  const needReviews =
    baseIsDefault &&
    !filesTruncated &&
    hits.length > 0 &&
    (cfg.unlockMode === "both" || !unlockCovers(hits, approvedFiles));
  if (needReviews) {
    try {
      reviews = await listPullRequestReviews(ref, args.prNumber);
    } catch (e) {
      // Deliberately left null rather than treated as "nobody approved". A
      // failed read is not evidence of absence, and `evaluateGuard` falls back
      // to the stored sign-off, which is our own record of a real approval.
      logger.warn(
        { err: e, prNumber: args.prNumber },
        "guard: review list failed; falling back to the stored sign-off",
      );
    }
  }

  // --- decide ---------------------------------------------------------------

  const verdict = evaluateGuard({
    cfg,
    baseIsDefault,
    baseRef,
    defaultBranch,
    hits,
    filesTruncated,
    reviews,
    labelUnlockBy,
    approvedFiles,
    priorUnlock,
  });

  // --- apply ----------------------------------------------------------------

  await publishGuardCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    prCheckId: prCheck?.id ?? null,
    headSha: args.headSha,
    project: { id: project.id, checksEnabled: project.checksEnabled },
    payload: buildGuardCheckPayload(verdict),
  });

  await persistUnlock({
    prCheckId: prCheck?.id ?? null,
    projectId: project.id,
    repoFullName: args.repoFullName,
    prNumber: args.prNumber,
    verdict,
    priorUnlock,
    approvedFiles,
  });

  await reconcileBlockedLabel({
    ref,
    prNumber: args.prNumber,
    prCheckId: prCheck?.id ?? null,
    label: cfg.blockedLabel,
    blocked: !guardPasses(verdict),
    wasBlocked: prCheck?.guardLabelApplied ?? false,
  });

  return { verdict };
}

function toGuardFile(f: PrFileSummary) {
  return { filename: f.filename, sha: f.sha, status: f.status };
}

/** The same shape `serializeApprovedFiles` produces, so the two can be compared
 * as strings regardless of the key order the column happened to be written in. */
function canonicalApprovedFiles(approved: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const path of Object.keys(approved).sort()) out[path] = approved[path];
  return JSON.stringify(out);
}

/**
 * Write the sign-off, or clear it.
 *
 * The snapshot is rewritten on every pass that finds the PR unlocked, so a
 * reviewer who approves and then approves again after a guarded file changed
 * ends up with a record of what they signed off *last*. The audit distinguishes
 * a first unlock from a re-lock, because "this was green and is now red" is the
 * event a maintainer wants to see in the log.
 */
async function persistUnlock(args: {
  prCheckId: string | null;
  projectId: string;
  repoFullName: string;
  prNumber: number;
  verdict: GuardVerdict;
  priorUnlock: GuardUnlock | null;
  approvedFiles: Record<string, string>;
}): Promise<void> {
  if (!args.prCheckId) return;
  const { verdict } = args;

  try {
    if (verdict.kind === "unlocked") {
      const unlock = verdict.unlocks[0];
      const serialized = serializeApprovedFiles(verdict.hits);
      // Compared against a re-serialization of what we read, not against the
      // raw column: both sides then have sorted keys, so an unchanged sign-off
      // writes nothing and leaves no audit row. Without that, key order alone
      // could make every event look like a fresh approval.
      const changed =
        serialized !== canonicalApprovedFiles(args.approvedFiles) ||
        args.priorUnlock?.by !== unlock.by ||
        args.priorUnlock?.source !== unlock.source;
      if (!changed) return;
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: {
          guardUnlockSource: unlock.source,
          guardUnlockBy: unlock.by,
          guardUnlockAt: new Date(),
          guardApprovedFiles: serialized,
        },
      });
      await recordAudit({
        projectId: args.projectId,
        actorId: null,
        kind: "guard.unlocked",
        payload: {
          repoFullName: args.repoFullName,
          prNumber: args.prNumber,
          by: unlock.by,
          source: unlock.source,
          paths: verdict.hits.map((h) => h.path).slice(0, 50),
        },
      });
      return;
    }

    // Blocked or undecidable. Clear a sign-off that no longer covers the diff,
    // so the next pass cannot resurrect it, and say so in the log: a release
    // that was green and went red is worth a line.
    if (verdict.kind === "blocked" || verdict.kind === "undecidable") {
      if (!args.priorUnlock && Object.keys(args.approvedFiles).length === 0) {
        return;
      }
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: {
          guardUnlockSource: null,
          guardUnlockBy: null,
          guardUnlockAt: null,
          guardApprovedFiles: "{}",
        },
      });
      await recordAudit({
        projectId: args.projectId,
        actorId: null,
        kind: "guard.relocked",
        payload: {
          repoFullName: args.repoFullName,
          prNumber: args.prNumber,
          previouslyBy: args.priorUnlock?.by ?? null,
          reason:
            verdict.kind === "undecidable"
              ? "diff_too_large"
              : "guarded_files_changed",
        },
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, prCheckId: args.prCheckId },
      "guard: failed to persist the sign-off",
    );
  }
}

/**
 * Put the blocked marker label on, or take it off.
 *
 * Compared against the tracked flag (`PrCheck.guardLabelApplied`) first, which
 * is what keeps the steady state free: reconciles run on every push, and a PR
 * that has been green for a week must not pay a "remove the label" call on each
 * one. Same bargain `qaLabelApplied` makes on the QA board.
 *
 * A failed call leaves the flag where it was, so the next pass retries.
 */
async function reconcileBlockedLabel(args: {
  ref: ReturnType<typeof repoRef>;
  prNumber: number;
  prCheckId: string | null;
  label: string;
  blocked: boolean;
  wasBlocked: boolean;
}): Promise<void> {
  if (args.blocked === args.wasBlocked) return;

  try {
    if (args.blocked) {
      await ensureLabel(
        args.ref,
        args.label,
        "b60205",
        "Touches a guarded path and is awaiting sign-off",
      );
      await addLabel(args.ref, args.prNumber, args.label);
    } else {
      await removeLabelIfPresent(args.ref, args.prNumber, args.label);
    }
    if (args.prCheckId) {
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: { guardLabelApplied: args.blocked },
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, prNumber: args.prNumber, label: args.label },
      "guard: blocked label reconcile failed",
    );
  }
}
