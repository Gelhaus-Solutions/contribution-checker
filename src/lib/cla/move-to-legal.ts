import "server-only";
import { prisma } from "@/lib/db";
import { legal, type LegalProjectView } from "@/lib/cla/legal";
import { pushClaSettingsToLegal } from "@/lib/cla/store";

/**
 * Moves a project's CLA records to GPlatform Legal (GPLATLEGAL-61, D123):
 * enrols it, sends its history (texts, signatures, corporate CLAs, rosters,
 * waivers, and the chain entry by entry, which Legal hashes again and refuses
 * at the first that does not hold), and switches the project over once Legal
 * holds the same chain head as here.
 *
 * Signing never stops for it. The history is sent while the project is in use;
 * then, holding the project's row (which every local chain append waits for),
 * whatever was written meanwhile is sent, the heads are compared and
 * `claLegalEnrolledAt` is set in the same transaction. A local write that was
 * waiting finds the project moved and is refused (`ClaInLegalError`), so the
 * chain is never forked; the person tries again and signs in Legal.
 *
 * Safe to run again: Legal takes a row or an entry it holds as it is, and a
 * status that moved on here since moves on there too. The rows stay here as
 * the history as it was moved.
 */

export interface MoveReport {
  projectId: string;
  outcome: "moved" | "already" | "dry-run";
  sent: { versions: number; signatures: number; corporates: number; roster: number; waivers: number; events: number };
  head: string | null;
}

/** A batch Legal takes in one request: within its counts and well under its 16 MB body. */
const MAX_BATCH_BYTES = 8_000_000;
const EVENTS_PER_BATCH = 2000;

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

type Batch = {
  versions?: unknown[];
  signatures?: unknown[];
  corporates?: unknown[];
  roster?: unknown[];
  waivers?: unknown[];
  events?: unknown[];
  currentIclaVersionId?: string | null;
  currentCclaVersionId?: string | null;
};

type Rows = {
  versions: Awaited<ReturnType<typeof readVersions>>;
  signatures: Awaited<ReturnType<typeof readSignatures>>;
  corporates: Awaited<ReturnType<typeof readCorporates>>;
  roster: Awaited<ReturnType<typeof readRoster>>;
  waivers: Awaited<ReturnType<typeof readWaivers>>;
};

type Reader = Pick<
  typeof prisma,
  "claDocumentVersion" | "claSignature" | "corporateCla" | "cclaRosterMember" | "claWaiver" | "claEventLog"
>;

function readVersions(db: Reader, projectId: string, ids?: string[]) {
  return db.claDocumentVersion.findMany({
    where: { projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: [{ kind: "asc" }, { version: "asc" }],
  });
}
function readSignatures(db: Reader, projectId: string, ids?: string[]) {
  return db.claSignature.findMany({
    where: { projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { signedAt: "asc" },
  });
}
function readCorporates(db: Reader, projectId: string, ids?: string[]) {
  return db.corporateCla.findMany({
    where: { projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: "asc" },
  });
}
function readRoster(db: Reader, projectId: string, ids?: string[]) {
  return db.cclaRosterMember.findMany({
    where: { projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { addedAt: "asc" },
  });
}
function readWaivers(db: Reader, projectId: string, ids?: string[]) {
  return db.claWaiver.findMany({
    where: { projectId, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { grantedAt: "asc" },
  });
}

/** Rows as Legal's import takes them. */
const wire = {
  version: (v: Rows["versions"][number]) => ({
    id: v.id,
    kind: v.kind,
    version: v.version,
    bodyMarkdown: v.bodyMarkdown,
    contentHash: v.contentHash,
    sourceType: v.sourceType,
    sourceRepoId: v.sourceRepoId,
    sourcePath: v.sourcePath,
    sourceRef: v.sourceRef,
    sourceCommitSha: v.sourceCommitSha,
    requireResign: v.requireResign,
    resignRequired: v.resignRequired,
    publishedBy: v.publishedById,
    publishedAt: v.publishedAt.toISOString(),
  }),
  signature: (s: Rows["signatures"][number]) => ({
    id: s.id,
    versionId: s.versionId,
    kind: s.kind,
    userId: s.userId,
    ghId: s.ghId,
    ghLogin: s.ghLogin,
    emailSnapshot: s.emailSnapshot,
    legalName: s.legalName,
    affirmation: s.affirmation,
    agreed: s.agreed,
    documentVersion: s.documentVersion,
    contentHash: s.contentHash,
    signatureKind: s.signatureKind,
    signatureText: s.signatureText,
    signatureImage: s.signatureImage,
    ip: s.ip,
    userAgent: s.userAgent,
    applicationId: s.applicationId,
    customFields: s.customFields,
    status: s.status,
    revokedBy: s.revokedById,
    revokedAt: iso(s.revokedAt),
    revokeReason: s.revokeReason,
    signedAt: s.signedAt.toISOString(),
  }),
  corporate: (c: Rows["corporates"][number]) => ({
    id: c.id,
    versionId: c.versionId,
    signatureId: c.signatureId,
    companyName: c.companyName,
    registeredAddress: c.registeredAddress,
    country: c.country,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    signatoryTitle: c.signatoryTitle,
    signatureText: c.signatureText,
    status: c.status,
    approvedBy: c.approvedById,
    approvedAt: iso(c.approvedAt),
    rejectedBy: c.rejectedById,
    rejectedAt: iso(c.rejectedAt),
    rejectReason: c.rejectReason,
    revokedBy: c.revokedById,
    revokedAt: iso(c.revokedAt),
    createdAt: c.createdAt.toISOString(),
  }),
  member: (m: Rows["roster"][number]) => ({
    id: m.id,
    corporateId: m.corporateId,
    ghLogin: m.ghLogin,
    ghId: m.ghId,
    status: m.status,
    addedBy: m.addedById,
    addedAt: m.addedAt.toISOString(),
    revokedBy: m.revokedById,
    revokedAt: iso(m.revokedAt),
    disputedAt: iso(m.disputedAt),
    disputeNote: m.disputeNote,
  }),
  waiver: (w: Rows["waivers"][number]) => ({
    id: w.id,
    ghLogin: w.ghLogin,
    ghId: w.ghId,
    reason: w.reason,
    grantedBy: w.grantedById,
    grantedAt: w.grantedAt.toISOString(),
    status: w.status,
    revokedBy: w.revokedById,
    revokedAt: iso(w.revokedAt),
  }),
  event: (e: Awaited<ReturnType<Reader["claEventLog"]["findMany"]>>[number]) => ({
    seq: e.seq,
    kind: e.kind,
    payload: e.payload,
    actorUserId: e.actorUserId,
    actorGhId: e.actorGhId,
    signatureId: e.signatureId,
    documentVersionId: e.documentVersionId,
    rosterMemberId: e.rosterMemberId,
    corporateId: e.corporateId,
    waiverId: e.waiverId,
    prevHash: e.prevHash,
    entryHash: e.entryHash,
    createdAt: e.createdAt.toISOString(),
  }),
};

/** Splits rows into batches by size, so a project of drawn signatures still goes in requests Legal takes. */
function* bySize<T>(rows: T[], max: number): Generator<T[]> {
  let batch: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (batch.length > 0 && (bytes + size > MAX_BATCH_BYTES || batch.length >= max)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

async function send(projectId: string, rows: Rows, events: unknown[], sent: MoveReport["sent"]) {
  const post = (batch: Batch) => legal("POST", projectId, "import", batch);
  // Each kind after what it rests on: texts, signatures, the corporate CLAs
  // their signatories signed, rosters, waivers; then the chain.
  for (const batch of bySize(rows.versions.map(wire.version), 500)) await post({ versions: batch });
  for (const batch of bySize(rows.signatures.map(wire.signature), 2000)) await post({ signatures: batch });
  for (const batch of bySize(rows.corporates.map(wire.corporate), 1000)) await post({ corporates: batch });
  for (const batch of bySize(rows.roster.map(wire.member), 5000)) await post({ roster: batch });
  for (const batch of bySize(rows.waivers.map(wire.waiver), 2000)) await post({ waivers: batch });
  for (const batch of bySize(events, EVENTS_PER_BATCH)) await post({ events: batch });
  sent.versions += rows.versions.length;
  sent.signatures += rows.signatures.length;
  sent.corporates += rows.corporates.length;
  sent.roster += rows.roster.length;
  sent.waivers += rows.waivers.length;
  sent.events += events.length;
}

export async function moveClaToLegal(
  projectId: string,
  options: { dryRun?: boolean } = {}
): Promise<MoveReport> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, claLegalEnrolledAt: true },
  });
  if (!project) throw new Error(`No project ${projectId}.`);
  const sent = { versions: 0, signatures: 0, corporates: 0, roster: 0, waivers: 0, events: 0 };
  if (project.claLegalEnrolledAt) {
    return { projectId, outcome: "already", sent, head: null };
  }

  // 1. The history as it stands, while the project stays in use.
  const rows: Rows = {
    versions: await readVersions(prisma, projectId),
    signatures: await readSignatures(prisma, projectId),
    corporates: await readCorporates(prisma, projectId),
    roster: await readRoster(prisma, projectId),
    waivers: await readWaivers(prisma, projectId),
  };
  const events = await prisma.claEventLog.findMany({
    where: { projectId },
    orderBy: { seq: "asc" },
  });
  if (options.dryRun) {
    return {
      projectId,
      outcome: "dry-run",
      sent: {
        versions: rows.versions.length,
        signatures: rows.signatures.length,
        corporates: rows.corporates.length,
        roster: rows.roster.length,
        waivers: rows.waivers.length,
        events: events.length,
      },
      head: events.at(-1)?.entryHash ?? null,
    };
  }
  await pushClaSettingsToLegal(projectId, undefined, null);
  await send(projectId, rows, events.map(wire.event), sent);
  const sentUpTo = events.at(-1)?.seq ?? -1;

  // 2. Holding the project's row: what was written meanwhile, the heads, the switch.
  const head = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
      const later = await tx.claEventLog.findMany({
        where: { projectId, seq: { gt: sentUpTo } },
        orderBy: { seq: "asc" },
      });
      const ids = (pick: (e: (typeof later)[number]) => string | null) =>
        [...new Set(later.map(pick).filter((id): id is string => id !== null))];
      // A re-sign flag changes no row an entry names: the texts go again whole.
      const allVersions = later.some((e) => e.kind === "doc.resign_set");
      const delta: Rows = {
        versions: await readVersions(tx, projectId, allVersions ? undefined : ids((e) => e.documentVersionId)),
        signatures: await readSignatures(tx, projectId, ids((e) => e.signatureId)),
        corporates: await readCorporates(tx, projectId, ids((e) => e.corporateId)),
        roster: await readRoster(tx, projectId, ids((e) => e.rosterMemberId)),
        waivers: await readWaivers(tx, projectId, ids((e) => e.waiverId)),
      };
      await send(projectId, delta, later.map(wire.event), sent);
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { currentIclaVersionId: true, currentCclaVersionId: true },
      });
      await legal("POST", projectId, "import", {
        currentIclaVersionId: current.currentIclaVersionId,
        currentCclaVersionId: current.currentCclaVersionId,
      });
      const last = await tx.claEventLog.findFirst({
        where: { projectId },
        orderBy: { seq: "desc" },
        select: { seq: true, entryHash: true },
      });
      const there = await legal<LegalProjectView>("GET", projectId, "");
      const here = { entries: last === null ? 0 : last.seq + 1, head: last?.entryHash ?? null };
      if (there.chain.head !== here.head || there.chain.entries !== here.entries) {
        throw new Error(
          `GPlatform Legal holds ${String(there.chain.entries)} chain entries ending ${String(there.chain.head)}, and this project ${String(here.entries)} ending ${String(here.head)}: nothing was switched.`
        );
      }
      await tx.project.update({
        where: { id: projectId },
        data: { claLegalEnrolledAt: new Date() },
      });
      return here.head;
    },
    { timeout: 300_000, maxWait: 10_000 }
  );
  return { projectId, outcome: "moved", sent, head };
}
