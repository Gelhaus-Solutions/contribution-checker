"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { requireProjectRole } from "@/lib/authz";
import { signalQaBoardSync, signalStagingBatch } from "@/lib/temporal/start";
import { notifyProjectReviewers } from "@/lib/notifications/inbox";
import { countQa, isGreen, parseQaStatus, QA_STATUSES } from "@/lib/qa/types";
import { adapterFor, boardCallbackUrl } from "@/lib/qa/board/sync";
import {
  DEFAULT_STATUS_LABELS,
  parseStatusMap,
  serializeStatusMap,
} from "@/lib/qa/board/types";

/**
 * Recording a QA verdict.
 *
 * Every action ends by signalling the repo's staging entity rather than talking
 * to GitHub itself. That keeps the house rule (GitHub side effects outside the
 * webhook path go through Temporal) and gets the debounce for free: a reviewer
 * ticking off eight items in twenty seconds produces one reconcile, so the
 * release PR gets one edit rather than eight.
 */

const statusSchema = z.enum(QA_STATUSES);

const setStatusSchema = z
  .object({
    projectId: z.string().min(1),
    itemIds: z.array(z.string().min(1)).min(1).max(200),
    status: statusSchema,
    notes: z.string().max(2000).optional(),
  })
  // A failure with no reason is not a QA result, it is a shrug: the note is
  // what the author reads and what the release PR prints. Enforced here rather
  // than in the UI so the API cannot be talked out of it.
  .refine((v) => v.status !== "QA_FAILED" || !!v.notes?.trim(), {
    message: "A failed item needs a note saying what went wrong.",
    path: ["notes"],
  });

export type SetQaStatusResult = {
  updated: number;
  /** The batch became fully resolved with nothing failed on this call. */
  wentGreen: boolean;
};

export async function setQaStatus(args: {
  projectId: string;
  itemIds: string[];
  status: (typeof QA_STATUSES)[number];
  notes?: string;
}): Promise<SetQaStatusResult> {
  const parsed = setStatusSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");

  // Scoped through the batch to the repo to the project, so an item id from
  // another project cannot be written by guessing it.
  const items = await prisma.stagingBatchItem.findMany({
    where: {
      id: { in: parsed.itemIds },
      batch: { repo: { projectId: parsed.projectId } },
    },
    select: {
      id: true,
      key: true,
      prNumber: true,
      qaStatus: true,
      batchId: true,
      batch: { select: { repoId: true, status: true } },
    },
  });
  if (items.length === 0) return { updated: 0, wentGreen: false };

  const notes = parsed.notes?.trim() || null;
  const now = new Date();
  const claimed = parsed.status === "QA_IN_REVIEW";

  // Pending is the absence of a verdict, so it keeps no author, time or note.
  // A claim has an owner but no verdict time yet.
  const verdict =
    parsed.status === "QA_PENDING"
      ? { qaById: null, qaAt: null, qaNotes: null }
      : {
          qaById: session.user.id,
          qaAt: claimed ? null : now,
          qaNotes: notes,
        };

  await prisma.stagingBatchItem.updateMany({
    where: { id: { in: items.map((i) => i.id) } },
    data: {
      qaStatus: parsed.status,
      // A local reviewer's verdict supersedes whatever the external board said,
      // so the external attribution is cleared rather than left to contradict it.
      qaByExternal: null,
      ...verdict,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "qa.item_status_changed",
    payload: {
      status: parsed.status,
      count: items.length,
      items: items.slice(0, 50).map((i) => ({
        key: i.key,
        prNumber: i.prNumber,
        from: i.qaStatus,
      })),
      ...(notes ? { notes } : {}),
    },
  });

  const wentGreen = await announceIfGreen({
    projectId: parsed.projectId,
    batchId: items[0].batchId,
    actorId: session.user.id,
  });

  // One signal per affected repo, not per item. Both are best-effort: the
  // verdict is already committed, and neither the release PR nor an external
  // board is allowed to fail the write that recorded it.
  for (const repoId of new Set(items.map((i) => i.batch.repoId))) {
    await signalStagingBatch({ repoId, reason: "qa_changed" });
    await signalQaBoardSync({ repoId, reason: "qa_changed" });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/qa`);
  return { updated: items.length, wentGreen };
}

/**
 * Tell the reviewers when the last outstanding item closes.
 *
 * Deliberately only on the transition. "The batch is ready" is worth one
 * notification when it becomes true; sending it on every verdict afterwards
 * would train people to ignore the one that mattered.
 */
async function announceIfGreen(args: {
  projectId: string;
  batchId: string;
  actorId: string;
}): Promise<boolean> {
  try {
    const batch = await prisma.stagingBatch.findUnique({
      where: { id: args.batchId },
      select: {
        status: true,
        repo: {
          select: { id: true, fullName: true, project: { select: { slug: true } } },
        },
        items: { select: { qaStatus: true, droppedAt: true } },
      },
    });
    if (!batch || batch.status !== "OPEN") return false;

    const counts = countQa(
      batch.items.map((i) => ({
        qaStatus: parseQaStatus(i.qaStatus),
        droppedAt: i.droppedAt,
      })),
    );
    if (!isGreen(counts)) return false;

    await notifyProjectReviewers({
      projectId: args.projectId,
      excludeUserId: args.actorId,
      kind: "qa.batch_ready",
      payload: {
        projectId: args.projectId,
        projectSlug: batch.repo.project.slug,
        repoId: batch.repo.id,
        repoFullName: batch.repo.fullName,
        total: counts.total,
      },
    });
    return true;
  } catch (e) {
    logger.warn({ err: e, batchId: args.batchId }, "qa green notify failed");
    return false;
  }
}

// ===== External board links =====

const linkSchema = z.object({
  projectId: z.string().min(1),
  repoId: z.string().min(1),
  provider: z.enum(["notion", "trello"]),
  // Notion: the database id. Trello: the board id.
  targetId: z.string().min(1).max(200),
  token: z.string().min(1).max(500),
  apiKey: z.string().max(500).optional(),
});

export type LinkQaBoardResult = { ok: true } | { ok: false; error: string };

/**
 * Connect a repo's QA board to Notion or Trello.
 *
 * The credentials are verified against the provider before the row is written.
 * A link that silently does nothing until somebody notices the board is stale
 * is worse than no link, and the provider's own error message ("your database
 * has no Status property") is far more useful than anything we could infer an
 * hour later inside a background sync.
 */
export async function linkQaBoard(args: {
  projectId: string;
  repoId: string;
  provider: "notion" | "trello";
  targetId: string;
  token: string;
  apiKey?: string;
}): Promise<LinkQaBoardResult> {
  const parsed = linkSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const repo = await prisma.repo.findUnique({
    where: { id: parsed.repoId },
    select: { projectId: true },
  });
  if (!repo || repo.projectId !== parsed.projectId) {
    throw new Error("Repo not found");
  }

  const adapter = adapterFor(parsed.provider);
  if (!adapter) return { ok: false, error: "Unknown provider." };

  const candidate = {
    id: "unsaved",
    repoId: parsed.repoId,
    provider: parsed.provider,
    targetId: parsed.targetId.trim(),
    token: parsed.token.trim(),
    apiKey: parsed.apiKey?.trim() || null,
    statusMap: DEFAULT_STATUS_LABELS as Record<string, string>,
  };

  const verified = await adapter.verify(candidate);
  if (!verified.ok) return { ok: false, error: verified.error };

  const link = await prisma.qaBoardLink.upsert({
    where: {
      repoId_provider: { repoId: parsed.repoId, provider: parsed.provider },
    },
    create: {
      repoId: parsed.repoId,
      provider: parsed.provider,
      targetId: candidate.targetId,
      token: candidate.token,
      apiKey: candidate.apiKey,
      statusMap: serializeStatusMap(DEFAULT_STATUS_LABELS),
      enabled: true,
    },
    update: {
      targetId: candidate.targetId,
      token: candidate.token,
      apiKey: candidate.apiKey,
      enabled: true,
      lastError: null,
      lastErrorAt: null,
    },
  });

  // Best-effort: the provider may not offer a per-target webhook (Notion does
  // not), and the poll is what actually guarantees delivery either way.
  try {
    const hookId = await adapter.registerHook(
      { ...candidate, id: link.id },
      boardCallbackUrl(parsed.provider),
    );
    if (hookId) {
      await prisma.qaBoardLink.update({
        where: { id: link.id },
        data: { hookId },
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, provider: parsed.provider },
      "qa board webhook registration failed; falling back to polling",
    );
  }

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "qa.board_linked",
    // Never the token. An audit log is a place people paste into tickets.
    payload: {
      provider: parsed.provider,
      repoId: parsed.repoId,
      targetId: candidate.targetId,
    },
  });

  await signalQaBoardSync({ repoId: parsed.repoId, reason: "board_linked" });
  revalidatePath(`/dashboard/projects/${parsed.projectId}/qa`);
  return { ok: true };
}

const unlinkSchema = z.object({
  projectId: z.string().min(1),
  linkId: z.string().min(1),
});

export async function unlinkQaBoard(args: {
  projectId: string;
  linkId: string;
}): Promise<void> {
  const parsed = unlinkSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const link = await prisma.qaBoardLink.findFirst({
    where: { id: parsed.linkId, repo: { projectId: parsed.projectId } },
  });
  if (!link) return;

  const adapter = adapterFor(link.provider);
  if (adapter && link.hookId) {
    await adapter
      .unregisterHook({
        id: link.id,
        repoId: link.repoId,
        provider: link.provider,
        targetId: link.targetId,
        token: link.token,
        apiKey: link.apiKey,
        statusMap: parseStatusMap(link.statusMap),
      })
      .catch((e) =>
        logger.warn({ err: e }, "qa board webhook removal failed"),
      );
  }

  await prisma.qaBoardLink.delete({ where: { id: link.id } });

  // The cards stay where they are. Deleting somebody's Notion pages because
  // they disconnected an integration is not a decision this app gets to make;
  // the local pointers are cleared so nothing tries to write to them again.
  await prisma.stagingBatchItem.updateMany({
    where: {
      externalProvider: link.provider,
      batch: { repoId: link.repoId },
    },
    data: { externalProvider: null, externalId: null, externalHash: null },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "qa.board_unlinked",
    payload: { provider: link.provider, repoId: link.repoId },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/qa`);
}
