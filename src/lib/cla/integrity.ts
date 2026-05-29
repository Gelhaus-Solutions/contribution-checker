import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/** prevHash sentinel for the genesis entry (seq 0). */
export const GENESIS_PREV = "GENESIS";

/**
 * Every legally-relevant event kind recorded in the per-project hash-chained
 * ledger. `genesis` is written lazily as seq 0 on the first append.
 */
export type ChainKind =
  | "genesis"
  | "icla.signed"
  | "ccla.signed"
  | "doc.published"
  | "roster.added"
  | "roster.revoked"
  | "roster.disputed"
  | "signature.revoked"
  | "waiver.granted"
  | "waiver.revoked";

/**
 * Deterministic, key-sorted JSON serialization. Object keys are emitted in
 * sorted order (recursively); arrays preserve their order; primitives go
 * through `JSON.stringify`. Used so the hash is independent of insertion
 * order of object keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      // Mirror JSON.stringify: drop undefined-valued keys.
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // Primitives (string, number, boolean) and undefined.
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 (hex) over the newline-joined tuple
 * `seq | projectId | kind | prevHash | canonicalJson(payload)`.
 * No timestamp participates in the hash.
 */
export function computeEntryHash(a: {
  seq: number;
  projectId: string;
  kind: ChainKind;
  prevHash: string;
  payload: unknown;
}): string {
  const material = [
    String(a.seq),
    a.projectId,
    a.kind,
    a.prevHash,
    canonicalJson(a.payload),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Append one event to a project's ledger inside the caller's transaction.
 *
 * Reads MAX(seq) for the project within `tx`. If the chain is empty, a genesis
 * entry (seq 0, kind "genesis", prevHash GENESIS, payload `{ projectId }`) is
 * written first, then the real event is appended at the next seq. Returns the
 * real (non-genesis) entry's `{ seq, entryHash, id }`.
 */
export async function appendClaEvent(a: {
  tx: Prisma.TransactionClient;
  projectId: string;
  kind: ChainKind;
  payload: unknown;
  actorUserId?: string | null;
  actorGhId?: number | null;
  links?: {
    signatureId?: string;
    documentVersionId?: string;
    rosterMemberId?: string;
    corporateId?: string;
    waiverId?: string;
  };
}): Promise<{ seq: number; entryHash: string; id: string }> {
  const { tx, projectId, kind, payload } = a;

  const last = await tx.claEventLog.findFirst({
    where: { projectId },
    orderBy: { seq: "desc" },
    select: { seq: true, entryHash: true },
  });

  let prevHash: string;
  let seq: number;

  if (!last) {
    // Lazily write the genesis entry, then the real event chains off it.
    const genesisPayload = { projectId };
    const genesisHash = computeEntryHash({
      seq: 0,
      projectId,
      kind: "genesis",
      prevHash: GENESIS_PREV,
      payload: genesisPayload,
    });
    await tx.claEventLog.create({
      data: {
        projectId,
        seq: 0,
        kind: "genesis",
        payload: JSON.stringify(genesisPayload),
        prevHash: GENESIS_PREV,
        entryHash: genesisHash,
      },
    });
    prevHash = genesisHash;
    seq = 1;
  } else {
    prevHash = last.entryHash;
    seq = last.seq + 1;
  }

  const entryHash = computeEntryHash({
    seq,
    projectId,
    kind,
    prevHash,
    payload,
  });

  const created = await tx.claEventLog.create({
    data: {
      projectId,
      seq,
      kind,
      payload: JSON.stringify(payload),
      actorUserId: a.actorUserId ?? null,
      actorGhId: a.actorGhId ?? null,
      signatureId: a.links?.signatureId ?? null,
      documentVersionId: a.links?.documentVersionId ?? null,
      rosterMemberId: a.links?.rosterMemberId ?? null,
      corporateId: a.links?.corporateId ?? null,
      waiverId: a.links?.waiverId ?? null,
      prevHash,
      entryHash,
    },
    select: { id: true },
  });

  return { seq, entryHash, id: created.id };
}

export type ChainVerifyResult =
  | { ok: true; entries: number; head: string | null }
  | {
      ok: false;
      brokenAtSeq: number;
      reason: "hash_mismatch" | "prev_mismatch" | "gap" | "missing_genesis";
    };

/**
 * Walk the project's ledger by ascending seq and verify integrity:
 * - seq 0 must exist, be kind "genesis", with prevHash GENESIS;
 * - seqs must be contiguous (0,1,2,...);
 * - each entryHash must match a recomputation;
 * - each prevHash must equal the prior entry's entryHash.
 * Returns the head (last entryHash) on success.
 */
export async function verifyChain(
  projectId: string
): Promise<ChainVerifyResult> {
  const entries = await prisma.claEventLog.findMany({
    where: { projectId },
    orderBy: { seq: "asc" },
    select: {
      seq: true,
      kind: true,
      payload: true,
      prevHash: true,
      entryHash: true,
    },
  });

  if (entries.length === 0) {
    return { ok: true, entries: 0, head: null };
  }

  const genesis = entries[0];
  if (
    genesis.seq !== 0 ||
    genesis.kind !== "genesis" ||
    genesis.prevHash !== GENESIS_PREV
  ) {
    return { ok: false, brokenAtSeq: genesis.seq, reason: "missing_genesis" };
  }

  let prevEntryHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // Contiguity: seq must equal its index.
    if (e.seq !== i) {
      return { ok: false, brokenAtSeq: e.seq, reason: "gap" };
    }

    // prevHash linkage.
    const expectedPrev = i === 0 ? GENESIS_PREV : prevEntryHash;
    if (e.prevHash !== expectedPrev) {
      return { ok: false, brokenAtSeq: e.seq, reason: "prev_mismatch" };
    }

    // Recompute and compare entryHash. payload is stored as a JSON string;
    // parse so the recomputed canonicalJson matches the original payload value.
    let payload: unknown;
    try {
      payload = JSON.parse(e.payload);
    } catch {
      return { ok: false, brokenAtSeq: e.seq, reason: "hash_mismatch" };
    }
    const recomputed = computeEntryHash({
      seq: e.seq,
      projectId,
      kind: e.kind as ChainKind,
      prevHash: e.prevHash,
      payload,
    });
    if (recomputed !== e.entryHash) {
      return { ok: false, brokenAtSeq: e.seq, reason: "hash_mismatch" };
    }

    prevEntryHash = e.entryHash;
  }

  return { ok: true, entries: entries.length, head: prevEntryHash };
}
