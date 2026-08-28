import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  addLabel,
  ensureLabel,
  removeLabelIfPresent,
  type RepoRef,
} from "@/lib/github/pr-actions";

/**
 * Carry a failed QA verdict onto GitHub as a label, on the PR that failed and
 * on the release PR shipping it.
 *
 * Two rules shape this:
 *
 * The label lives outside the `contribution:` namespace, like the staging
 * labels, because `setLabels` strips every `contribution:*` label the gate did
 * not just set. A QA label in that namespace would survive until the next time
 * anything touched the PR and then quietly vanish.
 *
 * And the applied state is tracked on the row rather than read back from
 * GitHub. A reconcile runs on every push to staging, so recomputing labels by
 * listing them, or by unconditionally issuing add/remove per PR, would cost one
 * or two API calls per PR in the batch every time. Comparing against what we
 * last did makes the steady state free, which is the same bargain the body
 * PATCH makes by diffing first.
 */
export async function syncQaLabels(args: {
  ref: RepoRef;
  batchId: string;
  failedLabel: string;
  aggregatePrNumber: number;
}): Promise<void> {
  const batch = await prisma.stagingBatch.findUnique({
    where: { id: args.batchId },
    select: { qaLabelApplied: true },
  });
  if (!batch) return;

  const items = await prisma.stagingBatchItem.findMany({
    where: { batchId: args.batchId, droppedAt: null },
    select: {
      id: true,
      prNumber: true,
      qaStatus: true,
      qaLabelApplied: true,
    },
  });

  const anyFailed = items.some((i) => i.qaStatus === "QA_FAILED");

  // Work out what actually has to change before touching GitHub at all.
  const itemChanges = items.filter(
    (i) =>
      i.prNumber != null && (i.qaStatus === "QA_FAILED") !== i.qaLabelApplied,
  );
  const aggregateChanges = anyFailed !== batch.qaLabelApplied;
  if (itemChanges.length === 0 && !aggregateChanges) return;

  // Create the label once, and only when something is about to carry it.
  if (anyFailed) {
    await ensureLabel(
      args.ref,
      args.failedLabel,
      "b60205",
      "Verified during staging QA and did not pass",
    );
  }

  for (const item of itemChanges) {
    const shouldHave = item.qaStatus === "QA_FAILED";
    try {
      if (shouldHave) {
        await addLabel(args.ref, item.prNumber as number, args.failedLabel);
      } else {
        await removeLabelIfPresent(
          args.ref,
          item.prNumber as number,
          args.failedLabel,
        );
      }
      await prisma.stagingBatchItem.update({
        where: { id: item.id },
        data: { qaLabelApplied: shouldHave },
      });
    } catch (e) {
      // Left un-flagged on failure, so the next reconcile tries again rather
      // than believing a label it never managed to set.
      logger.warn(
        { err: e, prNumber: item.prNumber, batchId: args.batchId },
        "qa label update failed",
      );
    }
  }

  if (aggregateChanges) {
    try {
      if (anyFailed) {
        await addLabel(args.ref, args.aggregatePrNumber, args.failedLabel);
      } else {
        await removeLabelIfPresent(
          args.ref,
          args.aggregatePrNumber,
          args.failedLabel,
        );
      }
      await prisma.stagingBatch.update({
        where: { id: args.batchId },
        data: { qaLabelApplied: anyFailed },
      });
    } catch (e) {
      logger.warn(
        { err: e, prNumber: args.aggregatePrNumber, batchId: args.batchId },
        "qa label update failed on the aggregate PR",
      );
    }
  }
}
