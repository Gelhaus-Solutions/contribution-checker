import { createHash } from "node:crypto";
import { QA_STATUSES, type QaStatus } from "@/lib/qa/types";

/**
 * Mirroring the QA board into Notion or Trello, in both directions.
 *
 * Two properties make this safe, and both are worth stating plainly because
 * getting either wrong turns a mirror into an infinite loop or a data-loss bug.
 *
 * **Loop safety.** Push writes a card; the provider fires a change event; the
 * pull reads it back; the push fires again. The cycle is broken the same way
 * the aggregate PR body avoids edit storms: write only when the rendered
 * content actually changed. `StagingBatchItem.externalHash` is the hash of the
 * fields last pushed, so our own echo hashes identically and is skipped. In the
 * other direction the pull applies a change only when it decodes to a
 * *different* status than the one held locally. One side needs a hash mismatch
 * and the other needs a status difference, so neither can drive the other.
 *
 * **Conflict.** Both sides can be edited at once. Last writer wins on
 * timestamp, and a tie goes to us, because the local side is the one with an
 * audit trail and a named user attached.
 */

/** The QA fields mirrored onto a card. Anything not here cannot cause a push. */
export type BoardCardPayload = {
  title: string;
  status: QaStatus;
  /** Link back to the PR, so the card is useful on its own. */
  url: string | null;
  summary: string | null;
  qaSteps: string | null;
  notes: string | null;
};

/**
 * A verdict read back off a provider.
 *
 * `status` is null when the card's status did not decode to anything we know,
 * which happens when somebody renames a Notion option or drags a card to a list
 * outside the mapping. Those are ignored rather than guessed at.
 */
export type ExternalVerdict = {
  externalId: string;
  status: QaStatus | null;
  actor: string | null;
  editedAt: Date;
};

/** The stored credentials and mapping for one repo/provider pair. */
export type BoardLink = {
  id: string;
  repoId: string;
  provider: string;
  targetId: string;
  token: string;
  apiKey: string | null;
  statusMap: Record<string, string>;
};

export type BoardAdapter = {
  /** Human name, for error messages and the settings page. */
  readonly provider: string;
  createCard(
    link: BoardLink,
    payload: BoardCardPayload,
  ): Promise<{ externalId: string; externalUrl: string }>;
  updateCard(
    link: BoardLink,
    externalId: string,
    payload: BoardCardPayload,
  ): Promise<void>;
  /** On ship, so a finished release stops cluttering the board. */
  archiveCard(link: BoardLink, externalId: string): Promise<void>;
  /**
   * Everything edited since `since`. A reconciling read rather than an event
   * handler: a webhook only ever makes this run sooner, so a missed or
   * unverifiable event costs latency, never state.
   */
  pullChanges(link: BoardLink, since: Date | null): Promise<ExternalVerdict[]>;
  /** Returns the provider-side id, or null when the provider has no per-target
   * webhook and polling is the only mechanism. */
  registerHook(link: BoardLink, callbackUrl: string): Promise<string | null>;
  unregisterHook(link: BoardLink): Promise<void>;
  /** Check the credentials and mapping when a link is created, so a typo is
   * reported on the settings page rather than swallowed by a sync an hour later. */
  verify(link: BoardLink): Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * Default status names. Notion reads them as select options, Trello as list
 * names, which is why they are phrased for a human reading a board rather than
 * as the enum values.
 */
export const DEFAULT_STATUS_LABELS: Record<QaStatus, string> = {
  QA_PENDING: "Not verified",
  QA_IN_REVIEW: "Being verified",
  QA_PASSED: "Verified",
  QA_FAILED: "Failed",
  QA_SKIPPED: "Skipped",
};

/**
 * Read the stored mapping. Falls back per key rather than wholesale, so a map
 * that names three of the five statuses still works for those three.
 */
export function parseStatusMap(raw: string | null | undefined): Record<QaStatus, string> {
  const out = { ...DEFAULT_STATUS_LABELS };
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const status of QA_STATUSES) {
      const value = (parsed as Record<string, unknown>)[status];
      if (typeof value === "string" && value.trim().length > 0) {
        out[status] = value.trim();
      }
    }
  } catch {
    // An unreadable map is the default map: the sync still works, it just uses
    // the names we would have picked.
  }
  return out;
}

export function serializeStatusMap(map: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const status of QA_STATUSES) {
    const value = map[status];
    if (typeof value === "string" && value.trim().length > 0) {
      out[status] = value.trim();
    }
  }
  return JSON.stringify(out);
}

/** Invert the mapping for reading a card back. Case-insensitive, because a
 * person typing a Notion option will not match our capitalization. */
export function decodeStatus(
  map: Record<QaStatus, string>,
  external: string | null | undefined,
): QaStatus | null {
  if (!external) return null;
  const needle = external.trim().toLowerCase();
  for (const status of QA_STATUSES) {
    if (map[status].trim().toLowerCase() === needle) return status;
  }
  return null;
}

/**
 * Hash of what we are about to push. Stored on the item and compared before the
 * next push, which is what stops our own write echoing back into another write.
 */
export function hashPayload(payload: BoardCardPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.title,
        payload.status,
        payload.url,
        payload.summary,
        payload.qaSteps,
        payload.notes,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Cap what we send. A card is a pointer to the PR, not a copy of it. */
export function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  const clean = value.trim();
  if (clean.length === 0) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}
