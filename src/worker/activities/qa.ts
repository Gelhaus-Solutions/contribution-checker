import { logger } from "@/lib/logger";
import { syncQaBoards } from "@/lib/qa/board/sync";
import { signalStagingBatch } from "@/lib/temporal/start";
import { prisma } from "@/lib/db";
import {
  getPullRequest,
  repoRef,
  updatePullRequestBody,
} from "@/lib/github/pr-actions";
import { applyTaskChanges } from "@/lib/qa/tasks";
import { extractQaSteps } from "@/lib/qa/extract";
import type { QaTaskToggleResult } from "@/lib/temporal/contracts";

/**
 * Activities for the external QA board mirror.
 *
 * The provider credentials are read inside `syncQaBoards`, never passed in as
 * activity arguments, so they never reach Temporal's workflow history. That is
 * the same rule `deliverOutboundAttempt` follows for outbound webhook secrets.
 */

export type SyncQaBoardResult = {
  applied: number;
  pushed: number;
  failed: number;
  /** Nothing left to mirror: no enabled links, or no open batch. The entity
   * completes on this rather than polling a repo with nothing to poll. */
  idle: boolean;
};

export async function syncQaBoard(args: {
  repoId: string;
}): Promise<SyncQaBoardResult> {
  const [links, batch] = await Promise.all([
    prisma.qaBoardLink.count({ where: { repoId: args.repoId, enabled: true } }),
    prisma.stagingBatch.findFirst({
      where: { repoId: args.repoId, status: "OPEN" },
      select: { id: true },
    }),
  ]);
  if (links === 0) return { applied: 0, pushed: 0, failed: 0, idle: true };

  const result = await syncQaBoards({ repoId: args.repoId });
  logger.debug(
    { repoId: args.repoId, ...result },
    "qa board sync pass complete",
  );
  // A repo with links but no batch in flight still has cards to archive on the
  // next ship, so it is only idle once there is nothing open to mirror.
  return { ...result, idle: batch == null };
}

/**
 * Hand a pulled verdict back to the staging entity, which owns the release PR
 * body and the QA check.
 *
 * An activity rather than a direct call from the workflow, because starting a
 * workflow needs the Temporal client and `start.ts` imports prisma, which
 * cannot be pulled into the deterministic workflow bundle.
 */
export async function signalStagingReconcile(args: {
  repoId: string;
  reason: string;
}): Promise<void> {
  await signalStagingBatch({ repoId: args.repoId, reason: args.reason });
}

/**
 * Tick or untick one checkbox in a PR's `## QA` section.
 *
 * Reads the body live rather than trusting the copy on the item row: somebody
 * may have edited the description since the board rendered, and the whole point
 * of the `expectedText` guard is to notice that instead of ticking whatever
 * happens to sit at that index now.
 *
 * The local `qaSteps` is refreshed from the body we just wrote, so the board and
 * the external cards reflect the tick immediately instead of waiting for the
 * next reconcile. A reconcile would re-derive the same value anyway, which is
 * what makes a failed write here self-correcting.
 */
export async function toggleQaTask(args: {
  itemId: string;
  changes: Array<{ index: number; expectedText: string; checked: boolean }>;
}): Promise<QaTaskToggleResult> {
  const item = await prisma.stagingBatchItem.findUnique({
    where: { id: args.itemId },
    select: {
      id: true,
      prNumber: true,
      batch: {
        select: {
          repo: { select: { fullName: true, installationId: true } },
        },
      },
    },
  });
  if (!item || item.prNumber == null) return { ok: false, reason: "not_found" };

  const { fullName, installationId } = item.batch.repo;
  if (installationId == null) return { ok: false, reason: "not_found" };
  const ref = repoRef(fullName, installationId);

  const pr = await getPullRequest(ref, item.prNumber);
  if (!pr) return { ok: false, reason: "not_found" };

  const result = applyTaskChanges({
    body: pr.body ?? "",
    changes: args.changes,
  });
  if (!result.ok) {
    logger.info(
      { itemId: args.itemId, prNumber: item.prNumber, reason: result.reason },
      "qa task write refused",
    );
    return { ok: false, reason: result.reason };
  }

  // Nothing actually moved: two reviewers ticking the same box, or a flush of
  // changes GitHub already has. Not worth an edit in the PR's timeline.
  if (result.applied === 0) return { ok: true, steps: extractQaSteps(pr.body ?? "") };

  await updatePullRequestBody(ref, item.prNumber, result.body);

  const steps = extractQaSteps(result.body);
  await prisma.stagingBatchItem.update({
    where: { id: item.id },
    // The external card carries the steps, so clearing the hash makes the next
    // board sync push the ticks out to Notion and Trello.
    data: { qaSteps: steps, externalHash: null },
  });

  return { ok: true, steps };
}
