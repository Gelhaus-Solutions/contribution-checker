import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendClaEvent } from "@/lib/cla/integrity";
import { invalidateClaCache } from "@/lib/cla/status";

// ---------------------------------------------------------------------------
// CLA operational mutations.
//
// DB-only writes + ledger appends. NO Octokit, NO Check publishing, NO audit /
// notification side effects: the calling server actions own those (see the
// action table in the design doc). Every coverage-relevant write runs inside a
// single `prisma.$transaction` and appends exactly one `ClaEventLog` entry via
// `appendClaEvent` so the operational row and the hash-chained ledger entry
// commit atomically. Ledger payloads MUST match the shapes validated by
// `chainPayloadSchema` in `src/lib/cla/schema.ts` (parsed on read).
//
// Coverage-affecting mutations (sign / roster add / waiver / version publish)
// invalidate the short-TTL coverage LRU after the transaction commits.
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A captured signature: typed text, or a drawn/uploaded image data URL. */
export type ClaSignatureCapture = {
  kind: "typed" | "drawn" | "uploaded";
  text?: string | null;
  image?: string | null;
};

/** Columns + ledger fields for a captured signature (image hashed, not inlined). */
function signatureColumns(sig?: ClaSignatureCapture | null) {
  return {
    signatureKind: sig?.kind ?? null,
    signatureText: sig?.kind === "typed" ? (sig.text ?? null) : null,
    signatureImage: sig && sig.kind !== "typed" ? (sig.image ?? null) : null,
  };
}
function signatureLedger(sig?: ClaSignatureCapture | null) {
  const cols = signatureColumns(sig);
  return {
    signatureKind: cols.signatureKind,
    signatureText: cols.signatureText,
    signatureImageSha256: cols.signatureImage
      ? sha256Hex(cols.signatureImage)
      : null,
  };
}

/**
 * Publish a new immutable CLA document version. version = max(existing for
 * kind) + 1; contentHash = sha256(bodyMarkdown). Sets
 * `Project.current{Icla,Ccla}VersionId` to the new version, and when
 * `requireResign` also bumps `min{Icla,Ccla}Version` so prior signatures go
 * stale. Appends a `doc.published` ledger entry.
 */
export async function publishClaVersion(a: {
  projectId: string;
  kind: "ICLA" | "CCLA";
  bodyMarkdown: string;
  sourceType?: "manual" | "repo_file";
  sourceRepoId?: string | null;
  sourcePath?: string | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  requireResign: boolean;
  actorUserId: string | null;
}): Promise<{ id: string; version: number; contentHash: string }> {
  const sourceType = a.sourceType ?? "manual";
  const contentHash = sha256Hex(a.bodyMarkdown);

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: a.projectId },
      select: { id: true },
    });
    if (!project) throw new Error("Project not found");

    const last = await tx.claDocumentVersion.findFirst({
      where: { projectId: a.projectId, kind: a.kind },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;

    const doc = await tx.claDocumentVersion.create({
      data: {
        projectId: a.projectId,
        kind: a.kind,
        version,
        bodyMarkdown: a.bodyMarkdown,
        contentHash,
        sourceType,
        sourceRepoId: a.sourceRepoId ?? null,
        sourcePath: a.sourcePath ?? null,
        sourceRef: a.sourceRef ?? null,
        sourceCommitSha: a.sourceCommitSha ?? null,
        requireResign: a.requireResign,
        publishedById: a.actorUserId,
      },
      select: { id: true, publishedAt: true },
    });

    const projectUpdate: Prisma.ProjectUpdateInput =
      a.kind === "ICLA"
        ? {
            currentIclaVersionId: doc.id,
            ...(a.requireResign ? { minIclaVersion: version } : {}),
          }
        : {
            currentCclaVersionId: doc.id,
            ...(a.requireResign ? { minCclaVersion: version } : {}),
          };
    await tx.project.update({
      where: { id: a.projectId },
      data: projectUpdate,
    });

    await appendClaEvent({
      tx,
      projectId: a.projectId,
      kind: "doc.published",
      actorUserId: a.actorUserId,
      links: { documentVersionId: doc.id },
      payload: {
        kind: "doc.published",
        documentVersionId: doc.id,
        documentKind: a.kind,
        version,
        contentHash,
        sourceType,
        sourceRepoId: a.sourceRepoId ?? null,
        sourcePath: a.sourcePath ?? null,
        sourceRef: a.sourceRef ?? null,
        sourceCommitSha: a.sourceCommitSha ?? null,
        requireResign: a.requireResign,
        publishedAt: doc.publishedAt.toISOString(),
      },
    });

    return { id: doc.id, version, contentHash };
  });

  return result;
}

/**
 * Record an immutable ICLA click-wrap signature against the project's current
 * ICLA version. Snapshots identity + affirmation + version/contentHash + IP/UA.
 * Appends an `icla.signed` ledger entry.
 *
 * Accepts an optional `tx` so the apply flow can create the Application and the
 * signature atomically in a single transaction the caller owns. When `tx` is
 * supplied the caller is responsible for the transaction (and for invalidating
 * the cache after it commits); otherwise this opens its own.
 */
export async function recordIclaSignature(a: {
  projectId: string;
  userId: string | null;
  ghId: number;
  ghLogin: string;
  emailSnapshot?: string | null;
  legalName: string;
  affirmation: string;
  signature?: ClaSignatureCapture | null;
  customFields?: Record<string, string | boolean> | null;
  ip: string;
  userAgent: string;
  applicationId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<{ id: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ id: string }> => {
    const project = await tx.project.findUnique({
      where: { id: a.projectId },
      select: { currentIclaVersionId: true },
    });
    if (!project) throw new Error("Project not found");
    if (!project.currentIclaVersionId) {
      throw new Error(
        "No ICLA version has been published for this project yet."
      );
    }

    const version = await tx.claDocumentVersion.findUnique({
      where: { id: project.currentIclaVersionId },
      select: { id: true, version: true, contentHash: true, kind: true },
    });
    if (!version || version.kind !== "ICLA") {
      throw new Error("Current ICLA version is missing or invalid.");
    }

    const sig = await tx.claSignature.create({
      data: {
        projectId: a.projectId,
        versionId: version.id,
        kind: "ICLA",
        userId: a.userId,
        ghId: a.ghId,
        ghLogin: a.ghLogin,
        emailSnapshot: a.emailSnapshot ?? null,
        legalName: a.legalName,
        affirmation: a.affirmation,
        agreed: true,
        documentVersion: version.version,
        contentHash: version.contentHash,
        ...signatureColumns(a.signature),
        customFields:
          a.customFields && Object.keys(a.customFields).length > 0
            ? JSON.stringify(a.customFields)
            : null,
        ip: a.ip,
        userAgent: a.userAgent,
        applicationId: a.applicationId ?? null,
        status: "ACTIVE",
      },
      select: { id: true, signedAt: true },
    });

    await appendClaEvent({
      tx,
      projectId: a.projectId,
      kind: "icla.signed",
      actorUserId: a.userId,
      actorGhId: a.ghId,
      links: { signatureId: sig.id, documentVersionId: version.id },
      payload: {
        kind: "icla.signed",
        signatureId: sig.id,
        versionId: version.id,
        documentVersion: version.version,
        contentHash: version.contentHash,
        ghId: a.ghId,
        ghLogin: a.ghLogin,
        legalName: a.legalName,
        affirmation: a.affirmation,
        ...signatureLedger(a.signature),
        customFields: a.customFields ?? null,
        emailSnapshot: a.emailSnapshot ?? null,
        applicationId: a.applicationId ?? null,
        ip: a.ip,
        userAgent: a.userAgent,
        signedAt: sig.signedAt.toISOString(),
      },
    });

    return { id: sig.id };
  };

  // Caller owns the transaction (and post-commit cache invalidation).
  if (a.tx) return run(a.tx);

  const result = await prisma.$transaction(run);
  invalidateClaCache(a.projectId, a.ghId);
  return result;
}

/**
 * Record a Corporate CLA: an immutable CCLA signatory signature plus the
 * CorporateCla company record. Uses the project's current CCLA version. Appends
 * a `ccla.signed` ledger entry. Note CCLA coverage flows through the roster, so
 * no individual coverage cache is invalidated here.
 */
export async function recordCclaSignature(a: {
  projectId: string;
  userId: string | null;
  ghId: number;
  ghLogin: string;
  emailSnapshot?: string | null;
  legalName: string; // Authorized representative (name)
  affirmation: string;
  signature?: ClaSignatureCapture | null;
  customFields?: Record<string, string | boolean> | null;
  ip: string;
  userAgent: string;
  companyName: string; // Legal Entity (full legal name)
  registeredAddress?: string | null;
  country?: string | null;
  contactName?: string | null;
  signatoryTitle?: string | null; // representative's Title
  contactEmail: string;
}): Promise<{ corporateId: string; signatureId: string }> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: a.projectId },
      select: { currentCclaVersionId: true },
    });
    if (!project) throw new Error("Project not found");
    if (!project.currentCclaVersionId) {
      throw new Error(
        "No CCLA version has been published for this project yet."
      );
    }

    const version = await tx.claDocumentVersion.findUnique({
      where: { id: project.currentCclaVersionId },
      select: { id: true, version: true, contentHash: true, kind: true },
    });
    if (!version || version.kind !== "CCLA") {
      throw new Error("Current CCLA version is missing or invalid.");
    }

    const sig = await tx.claSignature.create({
      data: {
        projectId: a.projectId,
        versionId: version.id,
        kind: "CCLA",
        userId: a.userId,
        ghId: a.ghId,
        ghLogin: a.ghLogin,
        emailSnapshot: a.emailSnapshot ?? null,
        legalName: a.legalName,
        affirmation: a.affirmation,
        agreed: true,
        documentVersion: version.version,
        contentHash: version.contentHash,
        ...signatureColumns(a.signature),
        customFields:
          a.customFields && Object.keys(a.customFields).length > 0
            ? JSON.stringify(a.customFields)
            : null,
        ip: a.ip,
        userAgent: a.userAgent,
        status: "ACTIVE",
      },
      select: { id: true, signedAt: true },
    });

    // Mirror a human-readable signature onto the CorporateCla for the maintainer
    // view: the typed text, or a "(drawn)"/"(uploaded)" marker. The canonical
    // signature (incl. the image) lives on the ClaSignature above.
    const cclaSignatureText =
      a.signature?.kind === "typed"
        ? (a.signature.text ?? null)
        : a.signature
          ? `(${a.signature.kind})`
          : null;

    const corporate = await tx.corporateCla.create({
      data: {
        projectId: a.projectId,
        versionId: version.id,
        signatureId: sig.id,
        companyName: a.companyName,
        registeredAddress: a.registeredAddress ?? null,
        country: a.country ?? null,
        contactName: a.contactName ?? null,
        signatoryTitle: a.signatoryTitle ?? null,
        signatureText: cclaSignatureText,
        contactEmail: a.contactEmail,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    await appendClaEvent({
      tx,
      projectId: a.projectId,
      kind: "ccla.signed",
      actorUserId: a.userId,
      actorGhId: a.ghId,
      links: {
        signatureId: sig.id,
        documentVersionId: version.id,
        corporateId: corporate.id,
      },
      payload: {
        kind: "ccla.signed",
        corporateId: corporate.id,
        signatureId: sig.id,
        versionId: version.id,
        documentVersion: version.version,
        contentHash: version.contentHash,
        ghId: a.ghId,
        ghLogin: a.ghLogin,
        legalName: a.legalName,
        affirmation: a.affirmation,
        ...signatureLedger(a.signature),
        customFields: a.customFields ?? null,
        companyName: a.companyName,
        registeredAddress: a.registeredAddress ?? null,
        country: a.country ?? null,
        contactName: a.contactName ?? null,
        signatoryTitle: a.signatoryTitle ?? null,
        contactEmail: a.contactEmail,
        emailSnapshot: a.emailSnapshot ?? null,
        ip: a.ip,
        userAgent: a.userAgent,
        signedAt: sig.signedAt.toISOString(),
      },
    });

    return { corporateId: corporate.id, signatureId: sig.id };
  });
}

/**
 * Bulk-add roster members to a CorporateCla. Each entry that has an existing
 * DISPUTED member for this corporate (matched by ghId, else lowercased ghLogin)
 * is refused (collected into `skippedDisputed`, the consent gate). The rest
 * are created ACTIVE and each appends a `roster.added` ledger entry. Each newly
 * covered ghId has its coverage cache invalidated.
 */
export async function addRosterMembers(a: {
  corporateId: string;
  projectId: string;
  entries: { ghLogin: string; ghId?: number | null }[];
  actorUserId: string | null;
}): Promise<{
  added: { id: string; ghLogin: string }[];
  skippedDisputed: string[];
}> {
  const result = await prisma.$transaction(async (tx) => {
    const corporate = await tx.corporateCla.findUnique({
      where: { id: a.corporateId },
      select: { id: true, projectId: true },
    });
    if (!corporate) throw new Error("Corporate CLA not found");
    if (corporate.projectId !== a.projectId) {
      throw new Error("Corporate CLA does not belong to this project");
    }

    const added: { id: string; ghLogin: string }[] = [];
    const skippedDisputed: string[] = [];

    for (const entry of a.entries) {
      const ghLogin = entry.ghLogin.trim();
      const ghId = entry.ghId ?? null;
      const loginLower = ghLogin.toLowerCase();

      // Consent gate: refuse if a DISPUTED record exists for this corporate,
      // matched by ghId (when known) or by lowercased login.
      const disputed = await tx.cclaRosterMember.findFirst({
        where: {
          corporateId: a.corporateId,
          status: "DISPUTED",
          ...(ghId != null
            ? { OR: [{ ghId }, { ghLogin: loginLower }] }
            : { ghLogin: loginLower }),
        },
        select: { id: true },
      });
      if (disputed) {
        skippedDisputed.push(ghLogin);
        continue;
      }

      const member = await tx.cclaRosterMember.create({
        data: {
          corporateId: a.corporateId,
          projectId: a.projectId,
          ghLogin: loginLower,
          ghId,
          status: "ACTIVE",
          addedById: a.actorUserId,
        },
        select: { id: true, ghLogin: true },
      });

      await appendClaEvent({
        tx,
        projectId: a.projectId,
        kind: "roster.added",
        actorUserId: a.actorUserId,
        links: { rosterMemberId: member.id, corporateId: a.corporateId },
        payload: {
          kind: "roster.added",
          rosterMemberId: member.id,
          corporateId: a.corporateId,
          ghLogin: loginLower,
          ghId,
          addedAt: new Date().toISOString(),
        },
      });

      added.push({ id: member.id, ghLogin });
    }

    return { added, skippedDisputed };
  });

  return result;
}

/**
 * Revoke a roster member (status REVOKED). Append-only: the original ACTIVE
 * transition is retained in the ledger. Appends `roster.revoked` and
 * invalidates the member's coverage cache.
 */
export async function revokeRosterMember(a: {
  memberId: string;
  actorUserId: string | null;
}): Promise<void> {
  const invalidate = await prisma.$transaction(async (tx) => {
    const member = await tx.cclaRosterMember.findUnique({
      where: { id: a.memberId },
      select: {
        id: true,
        projectId: true,
        corporateId: true,
        ghLogin: true,
        ghId: true,
        status: true,
      },
    });
    if (!member) throw new Error("Roster member not found");
    if (member.status === "REVOKED") {
      throw new Error("Roster member is already revoked");
    }

    await tx.cclaRosterMember.update({
      where: { id: member.id },
      data: {
        status: "REVOKED",
        revokedById: a.actorUserId,
        revokedAt: new Date(),
      },
    });

    await appendClaEvent({
      tx,
      projectId: member.projectId,
      kind: "roster.revoked",
      actorUserId: a.actorUserId,
      links: { rosterMemberId: member.id, corporateId: member.corporateId },
      payload: {
        kind: "roster.revoked",
        rosterMemberId: member.id,
        corporateId: member.corporateId,
        ghLogin: member.ghLogin,
        ghId: member.ghId,
        revokedAt: new Date().toISOString(),
      },
    });

    return member.ghId != null
      ? { projectId: member.projectId, ghId: member.ghId }
      : null;
  });

  if (invalidate) invalidateClaCache(invalidate.projectId, invalidate.ghId);
}

/**
 * Dispute a roster membership: the listed contributor asserts they are not
 * affiliated. Sets status DISPUTED + disputedAt + note (coverage is immediately
 * suspended). Appends `roster.disputed` and invalidates the coverage cache. The
 * DISPUTED record blocks re-adding until the contributor consents.
 */
export async function disputeRosterMembership(a: {
  memberId: string;
  actorUserId: string | null;
  actorGhId: number | null;
  note?: string;
}): Promise<void> {
  const invalidate = await prisma.$transaction(async (tx) => {
    const member = await tx.cclaRosterMember.findUnique({
      where: { id: a.memberId },
      select: {
        id: true,
        projectId: true,
        corporateId: true,
        ghLogin: true,
        ghId: true,
        status: true,
      },
    });
    if (!member) throw new Error("Roster member not found");
    if (member.status === "DISPUTED") {
      throw new Error("Roster member is already disputed");
    }

    const now = new Date();
    await tx.cclaRosterMember.update({
      where: { id: member.id },
      data: {
        status: "DISPUTED",
        disputedAt: now,
        disputeNote: a.note ?? null,
      },
    });

    await appendClaEvent({
      tx,
      projectId: member.projectId,
      kind: "roster.disputed",
      actorUserId: a.actorUserId,
      actorGhId: a.actorGhId,
      links: { rosterMemberId: member.id, corporateId: member.corporateId },
      payload: {
        kind: "roster.disputed",
        rosterMemberId: member.id,
        corporateId: member.corporateId,
        ghLogin: member.ghLogin,
        ghId: member.ghId,
        disputeNote: a.note ?? null,
        disputedAt: now.toISOString(),
      },
    });

    return member.ghId != null
      ? { projectId: member.projectId, ghId: member.ghId }
      : null;
  });

  if (invalidate) invalidateClaCache(invalidate.projectId, invalidate.ghId);
}

/**
 * Admin-revoke a signature (status REVOKED). Append-only; the original ACTIVE
 * signature is retained as the legal record. Appends `signature.revoked` and
 * invalidates the signer's coverage cache.
 */
export async function revokeSignature(a: {
  signatureId: string;
  actorUserId: string | null;
  reason: string;
}): Promise<void> {
  const invalidate = await prisma.$transaction(async (tx) => {
    const sig = await tx.claSignature.findUnique({
      where: { id: a.signatureId },
      select: {
        id: true,
        projectId: true,
        ghId: true,
        ghLogin: true,
        status: true,
      },
    });
    if (!sig) throw new Error("Signature not found");
    if (sig.status === "REVOKED") {
      throw new Error("Signature is already revoked");
    }

    await tx.claSignature.update({
      where: { id: sig.id },
      data: {
        status: "REVOKED",
        revokedById: a.actorUserId,
        revokedAt: new Date(),
        revokeReason: a.reason,
      },
    });

    await appendClaEvent({
      tx,
      projectId: sig.projectId,
      kind: "signature.revoked",
      actorUserId: a.actorUserId,
      actorGhId: sig.ghId,
      links: { signatureId: sig.id },
      payload: {
        kind: "signature.revoked",
        signatureId: sig.id,
        ghId: sig.ghId,
        ghLogin: sig.ghLogin,
        reason: a.reason,
        revokedAt: new Date().toISOString(),
      },
    });

    return { projectId: sig.projectId, ghId: sig.ghId };
  });

  invalidateClaCache(invalidate.projectId, invalidate.ghId);
}

/**
 * Grant an admin CLA waiver (exemption) for a GitHub account. Appends
 * `waiver.granted` and invalidates coverage when the ghId is known.
 */
export async function grantWaiver(a: {
  projectId: string;
  ghLogin: string;
  ghId?: number | null;
  reason: string;
  actorUserId: string | null;
}): Promise<{ id: string }> {
  const ghLogin = a.ghLogin.trim().toLowerCase();
  const ghId = a.ghId ?? null;

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: a.projectId },
      select: { id: true },
    });
    if (!project) throw new Error("Project not found");

    const waiver = await tx.claWaiver.create({
      data: {
        projectId: a.projectId,
        ghLogin,
        ghId,
        reason: a.reason,
        grantedById: a.actorUserId,
        status: "ACTIVE",
      },
      select: { id: true, grantedAt: true },
    });

    await appendClaEvent({
      tx,
      projectId: a.projectId,
      kind: "waiver.granted",
      actorUserId: a.actorUserId,
      links: { waiverId: waiver.id },
      payload: {
        kind: "waiver.granted",
        waiverId: waiver.id,
        ghLogin,
        ghId,
        reason: a.reason,
        grantedAt: waiver.grantedAt.toISOString(),
      },
    });

    return { id: waiver.id };
  });

  if (ghId != null) invalidateClaCache(a.projectId, ghId);
  return result;
}

/**
 * Revoke a waiver (status REVOKED). Append-only. Appends `waiver.revoked` and
 * invalidates coverage when the ghId is known.
 */
export async function revokeWaiver(a: {
  waiverId: string;
  actorUserId: string | null;
}): Promise<void> {
  const invalidate = await prisma.$transaction(async (tx) => {
    const waiver = await tx.claWaiver.findUnique({
      where: { id: a.waiverId },
      select: {
        id: true,
        projectId: true,
        ghLogin: true,
        ghId: true,
        status: true,
      },
    });
    if (!waiver) throw new Error("Waiver not found");
    if (waiver.status === "REVOKED") {
      throw new Error("Waiver is already revoked");
    }

    await tx.claWaiver.update({
      where: { id: waiver.id },
      data: {
        status: "REVOKED",
        revokedById: a.actorUserId,
        revokedAt: new Date(),
      },
    });

    await appendClaEvent({
      tx,
      projectId: waiver.projectId,
      kind: "waiver.revoked",
      actorUserId: a.actorUserId,
      links: { waiverId: waiver.id },
      payload: {
        kind: "waiver.revoked",
        waiverId: waiver.id,
        ghLogin: waiver.ghLogin,
        ghId: waiver.ghId,
        revokedAt: new Date().toISOString(),
      },
    });

    return waiver.ghId != null
      ? { projectId: waiver.projectId, ghId: waiver.ghId }
      : null;
  });

  if (invalidate) invalidateClaCache(invalidate.projectId, invalidate.ghId);
}
