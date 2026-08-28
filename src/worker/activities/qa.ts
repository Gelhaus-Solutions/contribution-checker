import { logger } from "@/lib/logger";
import { syncQaBoards } from "@/lib/qa/board/sync";
import { signalStagingBatch } from "@/lib/temporal/start";
import { prisma } from "@/lib/db";

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
