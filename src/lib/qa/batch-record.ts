import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import type { PrSummary } from "@/lib/github/pr-actions";
import {
  extractLinkedIssues,
  extractQaSteps,
  extractSummary,
} from "@/lib/qa/extract";
import { standingCheckKey } from "@/lib/qa/settings";
import { countQa, isGreen, parseQaStatus } from "@/lib/qa/types";
import type { QaRenderItem } from "@/lib/qa/render";
import { notifyProjectReviewers } from "@/lib/notifications/inbox";

/**
 * Keep the QA record for a repo's open batch in step with what the batch
 * actually ships.
 *
 * This mirrors the manifest exactly: re-derived from live GitHub on every
 * reconcile, so a dropped webhook cannot leave it stale. The QA columns are the
 * one thing that is *not* re-derived. They are human input, and a reconcile that
 * overwrote them would erase a morning of testing the first time somebody
 * pushed to the default branch.
 *
 * There is a single, deliberate exception: a changed `mergeCommitSha`. That
 * means the PR was merged again, so the code sitting in staging is not the code
 * anyone verified, and carrying the old verdict forward would be a lie told by
 * the release PR. Those reset to pending and say so in the audit log.
 */

export type BatchRecordResult = {
  batchId: string;
  /** Items created this pass. */
  added: number;
  /** Verdicts invalidated by a re-merge. */
  reset: number;
  /**
   * The batch was fully verified before this pass and is not any more, because
   * new work landed in it. The dangerous transition: the release looked ready,
   * somebody merged one more PR, and nothing on GitHub says the answer changed.
   */
  regressed: boolean;
};

/** What the board and the renderers read back. */
export type BatchItemRecord = {
  key: string;
  kind: string;
  prNumber: number | null;
  title: string;
  authorLogin: string | null;
  qaStatus: string;
  qaNotes: string | null;
  droppedAt: Date | null;
};

/**
 * The open batch's items, in the shape the renderers read.
 *
 * The reviewer's GitHub login is joined in here rather than stored on the row:
 * it is mutable (people rename), and a stale `@handle` on a release PR is worse
 * than one extra join on a page that already runs a dozen.
 */
export async function loadBatchItemsForRender(
  batchId: string,
): Promise<QaRenderItem[]> {
  const items = await prisma.stagingBatchItem.findMany({
    where: { batchId },
    select: {
      key: true,
      kind: true,
      prNumber: true,
      title: true,
      authorLogin: true,
      qaStatus: true,
      qaNotes: true,
      qaByExternal: true,
      droppedAt: true,
      qaBy: { select: { ghLogin: true } },
    },
  });
  return items.map((i) => ({
    key: i.key,
    kind: i.kind,
    prNumber: i.prNumber,
    title: i.title,
    authorLogin: i.authorLogin,
    qaStatus: i.qaStatus,
    qaNotes: i.qaNotes,
    qaByExternal: i.qaByExternal,
    droppedAt: i.droppedAt,
    qaByLogin: i.qaBy?.ghLogin ?? null,
  }));
}

/**
 * Tell the reviewers that a batch they had finished has grown.
 *
 * This is the alert the whole feature is built around. Everything else here is
 * bookkeeping somebody has to go and look at; this is the one case where the
 * state changed underneath a decision that had already been made, and nothing
 * on GitHub would otherwise say so.
 */
export async function notifyQaRegression(args: {
  projectId: string;
  repoId: string;
  added: number;
}): Promise<void> {
  const repo = await prisma.repo.findUnique({
    where: { id: args.repoId },
    select: { fullName: true, project: { select: { slug: true } } },
  });
  await notifyProjectReviewers({
    projectId: args.projectId,
    kind: "qa.items_added",
    payload: {
      projectId: args.projectId,
      projectSlug: repo?.project.slug,
      repoId: args.repoId,
      repoFullName: repo?.fullName,
      added: args.added,
    },
  });
}

/** Find the repo's open batch, or start one. */
async function openBatch(repoId: string, prNumber: number | null) {
  const existing = await prisma.stagingBatch.findFirst({
    where: { repoId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (existing) {
    if (prNumber != null && existing.prNumber !== prNumber) {
      await prisma.stagingBatch.update({
        where: { id: existing.id },
        data: { prNumber },
      });
    }
    return existing;
  }
  return prisma.stagingBatch.create({
    data: { repoId, status: "OPEN", prNumber },
  });
}

/** The shape a PR contributes to the record. */
function prItem(pr: PrSummary) {
  return {
    key: `pr:${pr.number}`,
    kind: "PR",
    prNumber: pr.number,
    // The manifest lets GitHub expand `#123` into the title, but the board is
    // not GitHub and has to carry its own copy.
    title: pr.title,
    authorLogin: pr.authorLogin,
    mergeCommitSha: pr.mergeCommitSha,
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    labels: JSON.stringify(pr.labels ?? []),
    linkedIssues: JSON.stringify(extractLinkedIssues(pr.body)),
    summary: extractSummary(pr.body),
    qaSteps: extractQaSteps(pr.body),
  };
}

/**
 * Standing checks carry no PR and no merge commit, so nothing about them ever
 * invalidates a verdict inside one batch. They are recreated per batch, which is
 * what makes "we smoke-tested this release" a per-release answer.
 */
function standingItem(label: string, index: number) {
  return {
    key: standingCheckKey(label, index),
    kind: "CHECK",
    prNumber: null,
    title: label,
    authorLogin: null,
    mergeCommitSha: null,
    mergedAt: null,
    labels: "[]",
    linkedIssues: "[]",
    summary: null,
    qaSteps: null,
  };
}

export async function syncBatchRecord(args: {
  repoId: string;
  projectId: string;
  prs: PrSummary[];
  standingChecks: string[];
  aggregatePrNumber: number | null;
}): Promise<BatchRecordResult> {
  const batch = await openBatch(args.repoId, args.aggregatePrNumber);

  const existing = await prisma.stagingBatchItem.findMany({
    where: { batchId: batch.id },
  });
  const byKey = new Map(existing.map((i) => [i.key, i]));

  // Green *before* this pass, measured on the items as they were. Read first,
  // because the upserts below are what might change the answer.
  const wasGreen = isGreen(
    countQa(
      existing.map((i) => ({
        qaStatus: parseQaStatus(i.qaStatus),
        droppedAt: i.droppedAt,
      })),
    ),
  );

  const desired = [
    ...args.prs.map(prItem),
    ...args.standingChecks.map(standingItem),
  ];

  let added = 0;
  let reset = 0;

  for (const item of desired) {
    const prior = byKey.get(item.key);
    if (!prior) {
      await prisma.stagingBatchItem.create({
        data: { batchId: batch.id, ...item },
      });
      added += 1;
      continue;
    }

    // A re-merge invalidates the verdict: what is in staging now is not what
    // was verified. Only when there *was* a verdict to invalidate, so a pending
    // item churning its merge sha costs nothing.
    const remerged =
      item.mergeCommitSha != null &&
      prior.mergeCommitSha != null &&
      item.mergeCommitSha !== prior.mergeCommitSha;
    const hadVerdict = parseQaStatus(prior.qaStatus) !== "QA_PENDING";
    const invalidate = remerged && hadVerdict;

    await prisma.stagingBatchItem.update({
      where: { id: prior.id },
      data: {
        ...item,
        // Re-derived fields always; QA fields only when invalidating. Spreading
        // `item` cannot touch them because it carries no qa* keys.
        droppedAt: null,
        ...(invalidate
          ? {
              qaStatus: "QA_PENDING",
              qaById: null,
              qaByExternal: null,
              qaAt: null,
              qaNotes: null,
            }
          : {}),
      },
    });

    if (invalidate) {
      reset += 1;
      await recordAudit({
        projectId: args.projectId,
        actorId: null,
        kind: "qa.item_reset",
        payload: {
          batchId: batch.id,
          key: item.key,
          prNumber: item.prNumber,
          previousStatus: prior.qaStatus,
          fromSha: prior.mergeCommitSha,
          toSha: item.mergeCommitSha,
          reason: "remerged",
        },
      }).catch((e) =>
        logger.warn({ err: e, batchId: batch.id }, "qa reset audit failed"),
      );
    }
  }

  // Anything left over has stopped shipping in this batch: its merge reached the
  // default branch by another route. Marked rather than deleted, because a
  // verdict somebody recorded is worth keeping even when the work leaves.
  const desiredKeys = new Set(desired.map((d) => d.key));
  const gone = existing.filter((i) => !desiredKeys.has(i.key) && !i.droppedAt);
  if (gone.length > 0) {
    await prisma.stagingBatchItem.updateMany({
      where: { id: { in: gone.map((i) => i.id) } },
      data: { droppedAt: new Date() },
    });
  }

  await prisma.stagingBatch.update({
    where: { id: batch.id },
    data: { updatedAt: new Date() },
  });

  const regressed = wasGreen && added > 0;
  if (regressed) {
    // Reported here, next to the only place that can detect it: the comparison
    // is between the batch as it was at the top of this function and the batch
    // as it is now, and nothing outside this call holds both.
    await notifyQaRegression({
      projectId: args.projectId,
      repoId: args.repoId,
      added,
    }).catch((e) =>
      logger.warn({ err: e, batchId: batch.id }, "qa regression notify failed"),
    );
  }

  return { batchId: batch.id, added, reset, regressed };
}

/**
 * The aggregate PR merged, so this batch is out the door. Freezing it here is
 * what turns the QA record into release history: who verified what, on the
 * release that actually shipped.
 */
export async function markBatchShipped(args: {
  repoId: string;
  projectId: string;
  prNumber: number;
  shippedAt: Date;
}): Promise<void> {
  const batch = await prisma.stagingBatch.findFirst({
    where: { repoId: args.repoId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (!batch) return;

  await prisma.stagingBatch.update({
    where: { id: batch.id },
    data: {
      status: "SHIPPED",
      shippedAt: args.shippedAt,
      prNumber: args.prNumber,
    },
  });

  const items = await prisma.stagingBatchItem.findMany({
    where: { batchId: batch.id },
    select: { qaStatus: true, droppedAt: true },
  });
  const counts = countQa(
    items.map((i) => ({
      qaStatus: parseQaStatus(i.qaStatus),
      droppedAt: i.droppedAt,
    })),
  );

  await recordAudit({
    projectId: args.projectId,
    actorId: null,
    kind: "qa.batch_shipped",
    payload: {
      batchId: batch.id,
      prNumber: args.prNumber,
      // Recorded even when it shipped unverified. Especially then: this is the
      // row somebody reads after an incident.
      ...counts,
    },
  }).catch((e) =>
    logger.warn({ err: e, batchId: batch.id }, "qa ship audit failed"),
  );
}
