import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { parseQaStatus } from "@/lib/qa/types";
import { notionAdapter } from "@/lib/qa/board/notion";
import { trelloAdapter } from "@/lib/qa/board/trello";
import {
  hashPayload,
  parseStatusMap,
  truncate,
  type BoardAdapter,
  type BoardCardPayload,
  type BoardLink,
} from "@/lib/qa/board/types";

/**
 * Drive both halves of the external board mirror for one repo.
 *
 * Pull runs before push, always. A reviewer's verdict recorded in Notion five
 * minutes ago should win the round it arrives in; pushing first would overwrite
 * their card with our stale view and then read our own write back as agreement.
 *
 * Every provider call is wrapped per link. One broken Notion token must not
 * stop the Trello mirror, and neither must stop the batch record, which is the
 * thing that actually gates the release.
 */

const ADAPTERS: Record<string, BoardAdapter> = {
  notion: notionAdapter,
  trello: trelloAdapter,
};

export function adapterFor(provider: string): BoardAdapter | null {
  return ADAPTERS[provider] ?? null;
}

/** Shipped batches whose cards we tidy up per run. Bounded so a repo with a
 * year of history does not archive everything on its next sync. */
const ARCHIVE_BATCHES_PER_RUN = 3;

const SUMMARY_MAX = 600;
const STEPS_MAX = 1500;

export type QaBoardSyncResult = {
  /** A pull changed local state, so the release PR and check need refreshing. */
  applied: number;
  pushed: number;
  failed: number;
};

const NOTHING: QaBoardSyncResult = { applied: 0, pushed: 0, failed: 0 };

function toLink(row: {
  id: string;
  repoId: string;
  provider: string;
  targetId: string;
  token: string;
  apiKey: string | null;
  statusMap: string;
}): BoardLink {
  return {
    id: row.id,
    repoId: row.repoId,
    provider: row.provider,
    targetId: row.targetId,
    token: row.token,
    apiKey: row.apiKey,
    statusMap: parseStatusMap(row.statusMap),
  };
}

function payloadFor(
  item: {
    prNumber: number | null;
    title: string;
    summary: string | null;
    qaSteps: string | null;
    qaStatus: string;
    qaNotes: string | null;
  },
  repoFullName: string,
): BoardCardPayload {
  return {
    title:
      item.prNumber != null ? `#${item.prNumber} ${item.title}` : item.title,
    status: parseQaStatus(item.qaStatus),
    url:
      item.prNumber != null
        ? `https://github.com/${repoFullName}/pull/${item.prNumber}`
        : null,
    summary: truncate(item.summary, SUMMARY_MAX),
    qaSteps: truncate(item.qaSteps, STEPS_MAX),
    notes: truncate(item.qaNotes, SUMMARY_MAX),
  };
}

export async function syncQaBoards(args: {
  repoId: string;
}): Promise<QaBoardSyncResult> {
  const repo = await prisma.repo.findUnique({
    where: { id: args.repoId },
    select: { id: true, fullName: true, projectId: true },
  });
  if (!repo) return NOTHING;

  const links = await prisma.qaBoardLink.findMany({
    where: { repoId: args.repoId, enabled: true },
  });
  if (links.length === 0) return NOTHING;

  const batch = await prisma.stagingBatch.findFirst({
    where: { repoId: args.repoId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });

  const total: QaBoardSyncResult = { applied: 0, pushed: 0, failed: 0 };

  for (const row of links) {
    const adapter = adapterFor(row.provider);
    if (!adapter) {
      logger.warn(
        { provider: row.provider, linkId: row.id },
        "qa board link names an unknown provider",
      );
      continue;
    }
    const link = toLink(row);
    try {
      await archiveShippedCards(link, adapter, args.repoId);
      if (batch) {
        total.applied += await pullInto({
          link,
          adapter,
          batchId: batch.id,
          projectId: repo.projectId,
          repoFullName: repo.fullName,
          since: row.lastPulledAt,
        });
        total.pushed += await pushFrom({
          link,
          adapter,
          batchId: batch.id,
          repoFullName: repo.fullName,
        });
      }
      await prisma.qaBoardLink.update({
        where: { id: row.id },
        data: { lastPulledAt: new Date(), lastError: null, lastErrorAt: null },
      });
    } catch (e) {
      total.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        { err: e, linkId: row.id, provider: row.provider },
        "qa board sync failed",
      );
      // Surfaced on the settings page. A link that has been failing since
      // Tuesday should say so rather than looking healthy and doing nothing.
      await prisma.qaBoardLink
        .update({
          where: { id: row.id },
          data: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
        })
        .catch(() => undefined);
      await recordAudit({
        projectId: repo.projectId,
        actorId: null,
        kind: "qa.board_sync_failed",
        payload: { provider: row.provider, repoId: args.repoId, error: message.slice(0, 300) },
      }).catch(() => undefined);
    }
  }

  return total;
}

/**
 * Apply verdicts recorded on the provider.
 *
 * Two guards, and both are load-bearing:
 *
 * A change is applied only when it decodes to a *different* status than the one
 * held here. That is what stops our own push echoing back as an external edit
 * and starting a cycle.
 *
 * And only when the card was edited after the local row, so a stale card cannot
 * undo a fresher local verdict. A tie goes to us: the local side is the one
 * with an audit trail and a named user on it.
 */
async function pullInto(args: {
  link: BoardLink;
  adapter: BoardAdapter;
  batchId: string;
  projectId: string;
  repoFullName: string;
  since: Date | null;
}): Promise<number> {
  const verdicts = await args.adapter.pullChanges(args.link, args.since);
  if (verdicts.length === 0) return 0;

  const items = await prisma.stagingBatchItem.findMany({
    where: {
      batchId: args.batchId,
      externalProvider: args.link.provider,
      externalId: { in: verdicts.map((v) => v.externalId) },
    },
  });
  const byExternal = new Map(items.map((i) => [i.externalId as string, i]));

  let applied = 0;
  for (const verdict of verdicts) {
    const item = byExternal.get(verdict.externalId);
    if (!item) continue;
    if (verdict.status == null) continue;
    if (verdict.status === parseQaStatus(item.qaStatus)) continue;
    if (verdict.editedAt <= item.updatedAt) continue;

    // The card already carries this status, so record the hash of what a push
    // would now send. Without it the next push rewrites the card with the value
    // we just read off it, which every provider records as another edit and
    // which shows up in Notion and Trello as the bot fighting the reviewer.
    const settled = hashPayload(
      payloadFor({ ...item, qaStatus: verdict.status }, args.repoFullName),
    );

    await prisma.stagingBatchItem.update({
      where: { id: item.id },
      data: {
        qaStatus: verdict.status,
        // No local user to attribute this to, so the board's actor is recorded
        // as text and the local reviewer field is cleared rather than left
        // naming somebody who did not make this call.
        qaById: null,
        qaByExternal: verdict.actor ?? args.link.provider,
        qaAt: verdict.editedAt,
        externalHash: settled,
      },
    });
    applied += 1;

    await recordAudit({
      projectId: args.projectId,
      actorId: null,
      kind: "qa.item_status_changed",
      payload: {
        source: args.link.provider,
        actor: verdict.actor,
        key: item.key,
        prNumber: item.prNumber,
        from: item.qaStatus,
        status: verdict.status,
      },
    }).catch(() => undefined);
  }
  return applied;
}

/**
 * Create the cards that do not exist and update the ones whose content moved.
 *
 * The hash comparison is the whole loop guard: an unchanged item is not written
 * at all, so a reconcile that happens every push to staging costs no provider
 * calls once the board has caught up.
 */
async function pushFrom(args: {
  link: BoardLink;
  adapter: BoardAdapter;
  batchId: string;
  repoFullName: string;
}): Promise<number> {
  const items = await prisma.stagingBatchItem.findMany({
    where: { batchId: args.batchId, droppedAt: null },
    orderBy: { prNumber: "asc" },
  });

  let pushed = 0;
  for (const item of items) {
    const payload = payloadFor(item, args.repoFullName);
    const hash = hashPayload(payload);

    const mine =
      item.externalProvider === args.link.provider && item.externalId != null;

    if (mine && item.externalHash === hash) continue;

    if (!mine) {
      const created = await args.adapter.createCard(args.link, payload);
      await prisma.stagingBatchItem.update({
        where: { id: item.id },
        data: {
          externalProvider: args.link.provider,
          externalId: created.externalId,
          externalUrl: created.externalUrl,
          externalHash: hash,
        },
      });
    } else {
      await args.adapter.updateCard(args.link, item.externalId as string, payload);
      await prisma.stagingBatchItem.update({
        where: { id: item.id },
        data: { externalHash: hash },
      });
    }
    pushed += 1;
  }
  return pushed;
}

/**
 * Close out the cards of batches that have already shipped, so the board shows
 * the release in flight rather than every release ever made.
 */
async function archiveShippedCards(
  link: BoardLink,
  adapter: BoardAdapter,
  repoId: string,
): Promise<void> {
  const shipped = await prisma.stagingBatch.findMany({
    where: {
      repoId,
      status: "SHIPPED",
      items: {
        some: { externalProvider: link.provider, externalId: { not: null } },
      },
    },
    orderBy: { shippedAt: "desc" },
    take: ARCHIVE_BATCHES_PER_RUN,
    select: { id: true },
  });

  for (const batch of shipped) {
    const items = await prisma.stagingBatchItem.findMany({
      where: {
        batchId: batch.id,
        externalProvider: link.provider,
        externalId: { not: null },
      },
      select: { id: true, externalId: true },
    });
    for (const item of items) {
      await adapter.archiveCard(link, item.externalId as string);
      // Cleared rather than kept: the card is gone, so a stale pointer would
      // only produce 404s on the next pull.
      await prisma.stagingBatchItem.update({
        where: { id: item.id },
        data: { externalProvider: null, externalId: null, externalHash: null },
      });
    }
  }
}

/** Where a provider should send its change notifications. */
export function boardCallbackUrl(provider: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/qa/${provider}`;
}
