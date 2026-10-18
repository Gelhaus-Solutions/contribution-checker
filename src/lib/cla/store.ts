import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ChainVerifyResult } from "@/lib/cla/integrity";
import { verifyChain } from "@/lib/cla/integrity";
import * as mutations from "@/lib/cla/mutations";
import type { ClaSignatureCapture } from "@/lib/cla/mutations";
import { getClaStatus, localClaStatus, type ClaStatusResult } from "@/lib/cla/status";
import {
  legal,
  legalAll,
  type LegalCorporateView,
  type LegalEventView,
  type LegalPage,
  type LegalRosterView,
  type LegalSignatureView,
  type LegalVersionView,
  type LegalWaiverView,
} from "@/lib/cla/legal";

/**
 * Where a project's CLA records are (GPLATLEGAL-61, D123): here, as they
 * always were, or in GPlatform Legal once the project moved there
 * (`Project.claLegalEnrolledAt`, set by `move-to-legal.ts`). Every CLA read
 * and write goes through a project's store, so the pages, the actions and the
 * PR gate do not care which.
 *
 * The rows are this product's own shapes (`revokedById`, dates as `Date`)
 * whichever store answers. Coverage is the same rule in both; Legal's answer
 * is passed on unchanged. Cache invalidation and PR re-gating stay with the
 * callers, as they always did for the local mutations.
 */

export type ClaKind = "ICLA" | "CCLA";

export interface ClaVersionRow {
  id: string;
  projectId: string;
  kind: string;
  version: number;
  contentHash: string;
  sourceType: string;
  sourceRepoId: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  requireResign: boolean;
  resignRequired: boolean;
  publishedById: string | null;
  publishedAt: Date;
  /** Only when one version is asked for. */
  bodyMarkdown?: string;
}

export interface ClaCompanyBlock {
  id: string;
  companyName: string;
  registeredAddress: string | null;
  country: string | null;
  contactName: string | null;
  contactEmail: string;
  signatoryTitle: string | null;
}

export interface ClaSignatureRow {
  id: string;
  projectId: string;
  versionId: string;
  kind: string;
  userId: string | null;
  ghId: number;
  ghLogin: string;
  emailSnapshot: string | null;
  legalName: string;
  affirmation: string;
  documentVersion: number;
  contentHash: string;
  signatureKind: string | null;
  signatureText: string | null;
  /** Only when one signature is asked for. */
  signatureImage?: string | null;
  ip: string;
  userAgent: string;
  applicationId: string | null;
  /** JSON, as kept. */
  customFields: string | null;
  status: string;
  revokedById: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  signedAt: Date;
  /** For a CCLA signatory, the company block it signed. */
  corporateSignatory: ClaCompanyBlock | null;
}

export interface ClaCorporateRow extends ClaCompanyBlock {
  projectId: string;
  versionId: string;
  signatureId: string;
  signatureText: string | null;
  status: string;
  approvedById: string | null;
  approvedAt: Date | null;
  rejectedById: string | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
  revokedById: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  signature: { userId: string | null; ghId: number; ghLogin: string; legalName: string };
}

export interface ClaRosterRow {
  id: string;
  corporateId: string;
  projectId: string;
  ghLogin: string;
  ghId: number | null;
  status: string;
  addedById: string | null;
  addedAt: Date;
  revokedById: string | null;
  revokedAt: Date | null;
  disputedAt: Date | null;
  disputeNote: string | null;
  companyName: string;
}

export interface ClaWaiverRow {
  id: string;
  projectId: string;
  ghLogin: string;
  ghId: number | null;
  reason: string;
  grantedById: string | null;
  grantedAt: Date;
  status: string;
  revokedById: string | null;
  revokedAt: Date | null;
}

export interface ClaEventRow {
  seq: number;
  kind: string;
  payload: string;
  actorUserId: string | null;
  actorGhId: number | null;
  signatureId: string | null;
  documentVersionId: string | null;
  rosterMemberId: string | null;
  corporateId: string | null;
  waiverId: string | null;
  prevHash: string;
  entryHash: string;
  createdAt: Date;
}

export type { ClaStatusResult };

export interface PublishArgs {
  kind: ClaKind;
  bodyMarkdown: string;
  sourceType?: "manual" | "repo_file";
  sourceRepoId?: string | null;
  sourcePath?: string | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  requireResign: boolean;
  resignVersionIds?: string[];
  resolvePendingChangeId?: string | null;
  actorUserId: string | null;
}

export interface SignArgs {
  /** The version the signer was shown: Legal refuses when a newer one is current. */
  versionId?: string;
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
}

export interface CompanyArgs {
  companyName: string;
  registeredAddress?: string | null;
  country?: string | null;
  contactName?: string | null;
  signatoryTitle?: string | null;
  contactEmail: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface ClaStore {
  readonly projectId: string;
  /** Whether the records are in Legal. */
  readonly inLegal: boolean;

  versions(): Promise<ClaVersionRow[]>;
  version(id: string): Promise<ClaVersionRow | null>;
  /** These versions, without their texts; any that are not the project's are left out. */
  versionsById(ids: string[]): Promise<ClaVersionRow[]>;
  publishVersion(a: PublishArgs): Promise<{
    id: string;
    version: number;
    contentHash: string;
    affectedGhIds: number[];
  }>;
  setVersionResign(a: {
    changes: { versionId: string; resignRequired: boolean }[];
    actorUserId: string | null;
  }): Promise<{ kind: ClaKind | null; affectedGhIds: number[] }>;

  signIcla(a: SignArgs & { applicationId?: string | null }): Promise<{ id: string }>;
  signCcla(a: SignArgs & CompanyArgs): Promise<{ corporateId: string; signatureId: string }>;
  signature(id: string): Promise<ClaSignatureRow | null>;
  /** Newest first; with each drawn or uploaded image where asked (a page of at most 50 then). */
  signatures(q: {
    q?: string;
    skip: number;
    take: number;
    ghId?: number;
    kind?: ClaKind;
    withImages?: boolean;
  }): Promise<Paged<ClaSignatureRow>>;
  revokeSignature(a: { signatureId: string; actorUserId: string | null; reason: string }): Promise<void>;

  corporate(id: string): Promise<ClaCorporateRow | null>;
  corporates(q: {
    q?: string;
    skip: number;
    take: number;
    signatoryUserId?: string;
  }): Promise<Paged<ClaCorporateRow> & { pending: number; disputed: number }>;
  approveCorporate(a: { corporateId: string; actorUserId: string | null }): Promise<{
    companyName: string;
    signatoryUserId: string | null;
    activeMemberGhIds: number[];
  }>;
  rejectCorporate(a: {
    corporateId: string;
    actorUserId: string | null;
    reason: string;
  }): Promise<{ companyName: string; signatoryUserId: string | null }>;
  revokeCorporate(a: {
    corporateId: string;
    actorUserId: string | null;
  }): Promise<{ companyName: string; affectedGhIds: number[] }>;

  rosterMember(id: string): Promise<ClaRosterRow | null>;
  /** Every roster entry that matches: of these corporate CLAs, and/or of this account. */
  roster(q: {
    corporateIds?: string[];
    ghId?: number | null;
    ghLogin?: string;
    status?: "ACTIVE" | "REVOKED" | "DISPUTED";
  }): Promise<ClaRosterRow[]>;
  addRosterMembers(a: {
    corporateId: string;
    entries: { ghLogin: string; ghId?: number | null }[];
    actorUserId: string | null;
  }): Promise<{ added: { id: string; ghLogin: string }[]; skippedDisputed: string[] }>;
  revokeRosterMember(a: { memberId: string; actorUserId: string | null }): Promise<void>;
  disputeRosterMembership(a: {
    memberId: string;
    actorUserId: string | null;
    actorGhId: number | null;
    note?: string;
  }): Promise<void>;

  waiver(id: string): Promise<ClaWaiverRow | null>;
  waivers(q: { q?: string; skip: number; take: number }): Promise<Paged<ClaWaiverRow>>;
  grantWaiver(a: {
    ghLogin: string;
    ghId?: number | null;
    reason: string;
    actorUserId: string | null;
  }): Promise<{ id: string }>;
  revokeWaiver(a: { waiverId: string; actorUserId: string | null }): Promise<void>;

  status(a: { ghId: number; ghLogin: string }): Promise<ClaStatusResult>;

  events(q: { skip: number; take: number; order?: "asc" | "desc" }): Promise<Paged<ClaEventRow>>;
  verify(): Promise<ChainVerifyResult>;
}

/** The store for a project: Legal once its records moved there, else here. */
export async function claStore(projectId: string): Promise<ClaStore> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { claLegalEnrolledAt: true },
  });
  return storeFor({ id: projectId, claLegalEnrolledAt: row?.claLegalEnrolledAt ?? null });
}

/** The store for a project already read, with `claLegalEnrolledAt`. */
export function storeFor(project: { id: string; claLegalEnrolledAt?: Date | null }): ClaStore {
  return project.claLegalEnrolledAt ? legalStore(project.id) : localStore(project.id);
}

async function allPages<T>(
  read: (skip: number, take: number) => Promise<Paged<T>>,
  size: number
): Promise<T[]> {
  const items: T[] = [];
  for (let skip = 0; ; skip += size) {
    const page = await read(skip, size);
    items.push(...page.items);
    if (page.items.length < size || items.length >= page.total) return items;
  }
}

/**
 * A project's whole CLA record, for its export: the chain in seq order and
 * every signature (with its image), corporate CLA, roster entry and waiver,
 * oldest first.
 */
export async function claRecord(store: ClaStore) {
  const [events, signatures, corporates, roster, waivers, integrity] = await Promise.all([
    allPages((skip, take) => store.events({ skip, take, order: "asc" }), 200),
    allPages((skip, take) => store.signatures({ skip, take, withImages: true }), 50),
    allPages((skip, take) => store.corporates({ skip, take }), 200),
    store.roster({}),
    allPages((skip, take) => store.waivers({ skip, take }), 200),
    store.verify(),
  ]);
  return {
    events,
    signatures: signatures.reverse(),
    corporates: corporates.reverse(),
    roster: roster.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime()),
    waivers: waivers.reverse(),
    integrity,
  };
}

/**
 * What GPlatform Legal holds about one person for this product's projects that
 * moved there, for their own export: null when no project moved; where Legal
 * cannot be reached, a note saying so rather than a silent gap.
 */
export async function claHeldInLegalFor(person: {
  userId: string;
  ghId: number | null;
  ghLogin: string | null;
}): Promise<unknown> {
  const moved = await prisma.project.count({ where: { claLegalEnrolledAt: { not: null } } });
  if (!(moved > 0)) return null;
  const query = [
    `userId=${encodeURIComponent(person.userId)}`,
    ...(person.ghId == null ? [] : [`ghId=${String(person.ghId)}`]),
    ...(person.ghLogin ? [`ghLogin=${encodeURIComponent(person.ghLogin)}`] : []),
  ].join("&");
  try {
    return await legal("GET", null, `people?${query}`);
  } catch (error) {
    return {
      unavailable: `GPlatform Legal could not be asked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The CLA settings Legal holds for a project, in this product's column names. */
export interface ClaSettings {
  claEnabled: boolean;
  claRequired: boolean;
  claCorporateEnabled: boolean;
  claCorporateRequiresApproval: boolean;
  claPlacementEmbed: boolean;
  claPlacementStandalone: boolean;
  labelClaPending: string;
}

/**
 * Tells Legal the project's name and CLA settings: `settings` as about to be
 * saved, or as saved when absent. Enrols the project if Legal does not know
 * it yet. Throws when Legal refuses, so a caller saves nothing it did not take.
 */
export async function pushClaSettingsToLegal(
  projectId: string,
  settings: ClaSettings | undefined,
  actorUserId: string | null
): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      slug: true,
      name: true,
      claEnabled: true,
      claRequired: true,
      claCorporateEnabled: true,
      claCorporateRequiresApproval: true,
      claPlacementEmbed: true,
      claPlacementStandalone: true,
      labelClaPending: true,
    },
  });
  const now = settings ?? project;
  await legal("PUT", projectId, "", {
    slug: project.slug,
    name: project.name,
    enabled: now.claEnabled,
    required: now.claRequired,
    corporateEnabled: now.claCorporateEnabled,
    corporateRequiresApproval: now.claCorporateRequiresApproval,
    placementEmbed: now.claPlacementEmbed,
    placementStandalone: now.claPlacementStandalone,
    labelPending: now.labelClaPending,
    actor: { actorUserId, actorGhId: null },
  });
}

// ---------------------------------------------------------------------------
// Here: the tables and mutations this product always had.
// ---------------------------------------------------------------------------

const insensitive = (q: string) => ({ contains: q, mode: "insensitive" as const });

const COMPANY_BLOCK = {
  select: {
    id: true,
    companyName: true,
    registeredAddress: true,
    country: true,
    contactName: true,
    contactEmail: true,
    signatoryTitle: true,
  },
} as const;

const SIGNATURE_ROW = {
  id: true,
  projectId: true,
  versionId: true,
  kind: true,
  userId: true,
  ghId: true,
  ghLogin: true,
  emailSnapshot: true,
  legalName: true,
  affirmation: true,
  documentVersion: true,
  contentHash: true,
  signatureKind: true,
  signatureText: true,
  ip: true,
  userAgent: true,
  applicationId: true,
  customFields: true,
  status: true,
  revokedById: true,
  revokedAt: true,
  revokeReason: true,
  signedAt: true,
  corporateSignatory: COMPANY_BLOCK,
} as const;

const VERSION_ROW = {
  id: true,
  projectId: true,
  kind: true,
  version: true,
  contentHash: true,
  sourceType: true,
  sourceRepoId: true,
  sourcePath: true,
  sourceRef: true,
  sourceCommitSha: true,
  requireResign: true,
  resignRequired: true,
  publishedById: true,
  publishedAt: true,
} as const;

const SIGNATORY = { select: { userId: true, ghId: true, ghLogin: true, legalName: true } } as const;

function rosterRowOf(row: {
  id: string;
  corporateId: string;
  projectId: string;
  ghLogin: string;
  ghId: number | null;
  status: string;
  addedById: string | null;
  addedAt: Date;
  revokedById: string | null;
  revokedAt: Date | null;
  disputedAt: Date | null;
  disputeNote: string | null;
  corporateCla: { companyName: string };
}): ClaRosterRow {
  const { corporateCla, ...rest } = row;
  return { ...rest, companyName: corporateCla.companyName };
}

export function localStore(projectId: string): ClaStore {
  return {
    projectId,
    inLegal: false,

    versions: () =>
      prisma.claDocumentVersion.findMany({
        where: { projectId },
        orderBy: [{ kind: "asc" }, { version: "desc" }],
        select: VERSION_ROW,
      }),
    version: (id) =>
      prisma.claDocumentVersion.findFirst({
        where: { id, projectId },
        select: { ...VERSION_ROW, bodyMarkdown: true },
      }),
    versionsById: (ids) =>
      prisma.claDocumentVersion.findMany({
        where: { id: { in: ids }, projectId },
        select: VERSION_ROW,
      }),
    publishVersion: (a) => mutations.publishClaVersion({ ...a, projectId }),
    setVersionResign: (a) => mutations.setVersionResign({ ...a, projectId }),

    // The version a signer was shown is checked by Legal; here the mutation
    // signs the current one, as it always did.
    signIcla: ({ versionId: _shown, ...a }) => mutations.recordIclaSignature({ ...a, projectId }),
    signCcla: ({ versionId: _shown, ...a }) => mutations.recordCclaSignature({ ...a, projectId }),
    signature: (id) =>
      prisma.claSignature.findFirst({
        where: { id, projectId },
        select: { ...SIGNATURE_ROW, signatureImage: true },
      }),
    async signatures(q) {
      const where: Prisma.ClaSignatureWhereInput = {
        projectId,
        ...(q.ghId === undefined ? {} : { ghId: q.ghId }),
        ...(q.kind === undefined ? {} : { kind: q.kind }),
        ...(q.q
          ? {
              OR: [
                { ghLogin: insensitive(q.q) },
                { legalName: insensitive(q.q) },
                { emailSnapshot: insensitive(q.q) },
              ],
            }
          : {}),
      };
      const [items, total] = await prisma.$transaction([
        prisma.claSignature.findMany({
          where,
          select: { ...SIGNATURE_ROW, signatureImage: q.withImages === true },
          orderBy: { signedAt: "desc" },
          skip: q.skip,
          take: q.take,
        }),
        prisma.claSignature.count({ where }),
      ]);
      return { items, total };
    },
    revokeSignature: (a) => mutations.revokeSignature(a),

    async corporate(id) {
      const row = await prisma.corporateCla.findFirst({
        where: { id, projectId },
        include: { signature: SIGNATORY },
      });
      return row;
    },
    async corporates(q) {
      const where: Prisma.CorporateClaWhereInput = {
        projectId,
        ...(q.signatoryUserId === undefined ? {} : { signature: { userId: q.signatoryUserId } }),
        ...(q.q
          ? { OR: [{ companyName: insensitive(q.q) }, { contactEmail: insensitive(q.q) }] }
          : {}),
      };
      const [items, total, disputed, pending] = await prisma.$transaction([
        prisma.corporateCla.findMany({
          where,
          include: { signature: SIGNATORY },
          orderBy: { createdAt: "desc" },
          skip: q.skip,
          take: q.take,
        }),
        prisma.corporateCla.count({ where }),
        prisma.cclaRosterMember.count({ where: { projectId, status: "DISPUTED" } }),
        prisma.corporateCla.count({ where: { projectId, status: "PENDING" } }),
      ]);
      return { items, total, pending, disputed };
    },
    approveCorporate: (a) => mutations.approveCorporateCla(a),
    rejectCorporate: (a) => mutations.rejectCorporateCla(a),
    revokeCorporate: (a) => mutations.revokeCorporateCla(a),

    async rosterMember(id) {
      const row = await prisma.cclaRosterMember.findFirst({
        where: { id, projectId },
        include: { corporateCla: { select: { companyName: true } } },
      });
      return row === null ? null : rosterRowOf(row);
    },
    async roster(q) {
      const login = q.ghLogin?.toLowerCase();
      const account = [
        ...(q.ghId == null ? [] : [{ ghId: q.ghId }]),
        ...(login === undefined ? [] : [{ ghLogin: login }]),
      ];
      const rows = await prisma.cclaRosterMember.findMany({
        where: {
          projectId,
          ...(q.corporateIds === undefined ? {} : { corporateId: { in: q.corporateIds } }),
          ...(q.status === undefined ? {} : { status: q.status }),
          ...(account.length === 0 ? {} : { OR: account }),
        },
        include: { corporateCla: { select: { companyName: true } } },
        orderBy: [{ status: "asc" }, { addedAt: "desc" }],
      });
      return rows.map(rosterRowOf);
    },
    addRosterMembers: (a) => mutations.addRosterMembers({ ...a, projectId }),
    revokeRosterMember: (a) => mutations.revokeRosterMember(a),
    disputeRosterMembership: (a) => mutations.disputeRosterMembership(a),

    waiver: (id) => prisma.claWaiver.findFirst({ where: { id, projectId } }),
    async waivers(q) {
      const where: Prisma.ClaWaiverWhereInput = {
        projectId,
        ...(q.q ? { OR: [{ ghLogin: insensitive(q.q) }, { reason: insensitive(q.q) }] } : {}),
      };
      const [items, total] = await prisma.$transaction([
        prisma.claWaiver.findMany({
          where,
          orderBy: { grantedAt: "desc" },
          skip: q.skip,
          take: q.take,
        }),
        prisma.claWaiver.count({ where }),
      ]);
      return { items, total };
    },
    grantWaiver: (a) => mutations.grantWaiver({ ...a, projectId }),
    revokeWaiver: (a) => mutations.revokeWaiver(a),

    status: (a) => localClaStatus({ projectId, ...a }),

    async events(q) {
      const [items, total] = await prisma.$transaction([
        prisma.claEventLog.findMany({
          where: { projectId },
          orderBy: { seq: q.order ?? "desc" },
          skip: q.skip,
          take: q.take,
        }),
        prisma.claEventLog.count({ where: { projectId } }),
      ]);
      return { items, total };
    },
    verify: () => verifyChain(projectId),
  };
}

// ---------------------------------------------------------------------------
// GPlatform Legal: the same, through its API.
// ---------------------------------------------------------------------------

const date = (value: string) => new Date(value);
const maybeDate = (value: string | null) => (value === null ? null : new Date(value));
const pageOf = (q: { skip: number; take: number }) =>
  `perPage=${String(Math.min(200, Math.max(1, q.take)))}&page=${String(Math.floor(q.skip / Math.max(1, q.take)) + 1)}`;
const param = (name: string, value: string | number | undefined | null) =>
  value === undefined || value === null || value === "" ? "" : `&${name}=${encodeURIComponent(String(value))}`;

function versionRow(projectId: string, view: LegalVersionView): ClaVersionRow {
  return {
    id: view.id,
    projectId,
    kind: view.kind,
    version: view.version,
    contentHash: view.contentHash,
    sourceType: view.sourceType,
    sourceRepoId: view.sourceRepoId,
    sourcePath: view.sourcePath,
    sourceRef: view.sourceRef,
    sourceCommitSha: view.sourceCommitSha,
    requireResign: view.requireResign,
    resignRequired: view.resignRequired,
    publishedById: view.publishedBy,
    publishedAt: date(view.publishedAt),
    ...(view.bodyMarkdown === undefined ? {} : { bodyMarkdown: view.bodyMarkdown }),
  };
}

function signatureRow(projectId: string, view: LegalSignatureView): ClaSignatureRow {
  return {
    id: view.id,
    projectId,
    versionId: view.versionId,
    kind: view.kind,
    userId: view.userId,
    ghId: view.ghId,
    ghLogin: view.ghLogin,
    emailSnapshot: view.emailSnapshot,
    legalName: view.legalName,
    affirmation: view.affirmation,
    documentVersion: view.documentVersion,
    contentHash: view.contentHash,
    signatureKind: view.signatureKind,
    signatureText: view.signatureText,
    ...(view.signatureImage === undefined ? {} : { signatureImage: view.signatureImage }),
    ip: view.ip,
    userAgent: view.userAgent,
    applicationId: view.applicationId,
    customFields:
      view.customFields !== null && Object.keys(view.customFields).length > 0
        ? JSON.stringify(view.customFields)
        : null,
    status: view.status,
    revokedById: view.revokedBy,
    revokedAt: maybeDate(view.revokedAt),
    revokeReason: view.revokeReason,
    signedAt: date(view.signedAt),
    corporateSignatory: view.corporate,
  };
}

function corporateRow(projectId: string, view: LegalCorporateView): ClaCorporateRow {
  return {
    id: view.id,
    projectId,
    versionId: view.versionId,
    signatureId: view.signatureId,
    companyName: view.companyName,
    registeredAddress: view.registeredAddress,
    country: view.country,
    contactName: view.contactName,
    contactEmail: view.contactEmail,
    signatoryTitle: view.signatoryTitle,
    signatureText: view.signatureText,
    status: view.status,
    approvedById: view.approvedBy,
    approvedAt: maybeDate(view.approvedAt),
    rejectedById: view.rejectedBy,
    rejectedAt: maybeDate(view.rejectedAt),
    rejectReason: view.rejectReason,
    revokedById: view.revokedBy,
    revokedAt: maybeDate(view.revokedAt),
    createdAt: date(view.createdAt),
    signature: view.signatory,
  };
}

function rosterRow(projectId: string, view: LegalRosterView): ClaRosterRow {
  return {
    id: view.id,
    corporateId: view.corporateId,
    projectId,
    ghLogin: view.ghLogin,
    ghId: view.ghId,
    status: view.status,
    addedById: view.addedBy,
    addedAt: date(view.addedAt),
    revokedById: view.revokedBy,
    revokedAt: maybeDate(view.revokedAt),
    disputedAt: maybeDate(view.disputedAt),
    disputeNote: view.disputeNote,
    companyName: view.companyName,
  };
}

function waiverRow(projectId: string, view: LegalWaiverView): ClaWaiverRow {
  return {
    id: view.id,
    projectId,
    ghLogin: view.ghLogin,
    ghId: view.ghId,
    reason: view.reason,
    grantedById: view.grantedBy,
    grantedAt: date(view.grantedAt),
    status: view.status,
    revokedById: view.revokedBy,
    revokedAt: maybeDate(view.revokedAt),
  };
}

function eventRow(view: LegalEventView): ClaEventRow {
  return {
    seq: view.seq,
    kind: view.kind,
    payload: view.payload,
    actorUserId: view.actorUserId,
    actorGhId: view.actorGhId,
    signatureId: view.signatureId,
    documentVersionId: view.documentVersionId,
    rosterMemberId: view.rosterMemberId,
    corporateId: view.corporateId,
    waiverId: view.waiverId,
    prevHash: view.prevHash,
    entryHash: view.entryHash,
    createdAt: date(view.createdAt),
  };
}

/** A read that answers 404 for a row that is not there: null, as a lookup here would. */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

const actor = (actorUserId: string | null, actorGhId: number | null = null) => ({
  actor: { actorUserId, actorGhId },
});

function signBody(a: SignArgs) {
  return {
    ...(a.versionId === undefined ? {} : { versionId: a.versionId }),
    userId: a.userId,
    ghId: a.ghId,
    ghLogin: a.ghLogin,
    emailSnapshot: a.emailSnapshot ?? null,
    legalName: a.legalName,
    affirmation: a.affirmation,
    signature:
      a.signature == null
        ? null
        : {
            kind: a.signature.kind,
            text: a.signature.kind === "typed" ? (a.signature.text ?? null) : null,
            image: a.signature.kind === "typed" ? null : (a.signature.image ?? null),
          },
    customFields: a.customFields ?? null,
    ip: a.ip,
    userAgent: a.userAgent,
  };
}

export function legalStore(projectId: string): ClaStore {
  const call = <T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) =>
    legal<T>(method, projectId, path, body);

  /**
   * Which versions new signatures sign is Legal's; the project row keeps a
   * mirror, which the gate and the pages read as they always did.
   */
  async function mirrorCurrent(): Promise<void> {
    const project = await call<{
      currentIclaVersionId: string | null;
      currentCclaVersionId: string | null;
      minIclaVersion: number;
      minCclaVersion: number;
    }>("GET", "");
    await prisma.project.update({
      where: { id: projectId },
      data: {
        currentIclaVersionId: project.currentIclaVersionId,
        currentCclaVersionId: project.currentCclaVersionId,
        minIclaVersion: project.minIclaVersion,
        minCclaVersion: project.minCclaVersion,
      },
    });
  }

  return {
    projectId,
    inLegal: true,

    async versions() {
      const all = await legalAll<LegalVersionView>(projectId, "versions", "");
      return all.map((one) => versionRow(projectId, one));
    },
    async version(id) {
      const view = await orNull(call<LegalVersionView>("GET", `versions/${encodeURIComponent(id)}`));
      return view === null ? null : versionRow(projectId, view);
    },
    async versionsById(ids) {
      const wanted = new Set(ids);
      return (await legalAll<LegalVersionView>(projectId, "versions", ""))
        .filter((one) => wanted.has(one.id))
        .map((one) => versionRow(projectId, one));
    },
    async publishVersion(a) {
      const published = await call<{
        id: string;
        version: number;
        contentHash: string;
        affectedGhIds: number[];
      }>("POST", "versions", {
        kind: a.kind,
        bodyMarkdown: a.bodyMarkdown,
        sourceType: a.sourceType ?? "manual",
        sourceRepoId: a.sourceRepoId ?? null,
        sourcePath: a.sourcePath ?? null,
        sourceRef: a.sourceRef ?? null,
        sourceCommitSha: a.sourceCommitSha ?? null,
        requireResign: a.requireResign,
        resignVersionIds: a.requireResign ? [] : (a.resignVersionIds ?? []),
        ...actor(a.actorUserId),
      });
      await mirrorCurrent();
      // A reviewed repository change is this product's workflow, not a legal
      // fact: it is resolved here once Legal has the version.
      if (a.resolvePendingChangeId) {
        await prisma.claPendingChange.update({
          where: { id: a.resolvePendingChangeId },
          data: {
            status: "APPROVED",
            reviewedById: a.actorUserId,
            reviewedAt: new Date(),
            publishedVersionId: published.id,
          },
        });
      }
      return published;
    },
    setVersionResign: (a) =>
      call("POST", "versions/resign", { changes: a.changes, ...actor(a.actorUserId) }),

    signIcla: (a) =>
      call("POST", "signatures", { ...signBody(a), applicationId: a.applicationId ?? null }),
    signCcla: (a) =>
      call<{ corporateId: string; signatureId: string }>("POST", "corporate", {
        ...signBody(a),
        companyName: a.companyName,
        registeredAddress: a.registeredAddress ?? null,
        country: a.country ?? null,
        contactName: a.contactName ?? null,
        signatoryTitle: a.signatoryTitle ?? null,
        contactEmail: a.contactEmail,
      }),
    async signature(id) {
      const view = await orNull(
        call<LegalSignatureView>("GET", `signatures/${encodeURIComponent(id)}`)
      );
      return view === null ? null : signatureRow(projectId, view);
    },
    async signatures(q) {
      const filters = `${param("q", q.q)}${param("ghId", q.ghId)}${param("kind", q.kind)}`;
      if (!q.withImages || q.take <= 50) {
        const page = await call<LegalPage<LegalSignatureView>>(
          "GET",
          `signatures?${pageOf(q)}${filters}${q.withImages ? "&withImages=true" : ""}`
        );
        return { items: page.items.map((one) => signatureRow(projectId, one)), total: page.total };
      }
      // Legal sends images 50 a page at most: the same rows in smaller pages.
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const common = gcd(q.skip, q.take);
      let size = Math.min(50, common);
      while (common % size !== 0) size -= 1;
      const items: ClaSignatureRow[] = [];
      let total = 0;
      for (let from = q.skip; from < q.skip + q.take; from += size) {
        const page = await call<LegalPage<LegalSignatureView>>(
          "GET",
          `signatures?${pageOf({ skip: from, take: size })}${filters}&withImages=true`
        );
        items.push(...page.items.map((one) => signatureRow(projectId, one)));
        total = page.total;
        if (page.items.length < size) break;
      }
      return { items, total };
    },
    async revokeSignature(a) {
      await call("POST", `signatures/${encodeURIComponent(a.signatureId)}/revoke`, {
        reason: a.reason,
        ...actor(a.actorUserId),
      });
    },

    async corporate(id) {
      const view = await orNull(
        call<LegalCorporateView>("GET", `corporate/${encodeURIComponent(id)}`)
      );
      return view === null ? null : corporateRow(projectId, view);
    },
    async corporates(q) {
      const page = await call<
        LegalPage<LegalCorporateView> & { counts: { pending: number; disputed: number } }
      >(
        "GET",
        `corporate?${pageOf(q)}${param("q", q.q)}${param("signatoryUserId", q.signatoryUserId)}`
      );
      return {
        items: page.items.map((one) => corporateRow(projectId, one)),
        total: page.total,
        pending: page.counts.pending,
        disputed: page.counts.disputed,
      };
    },
    async approveCorporate(a) {
      const done = await call<{ corporate: LegalCorporateView; affectedGhIds: number[] }>(
        "POST",
        `corporate/${encodeURIComponent(a.corporateId)}/approve`,
        actor(a.actorUserId)
      );
      return {
        companyName: done.corporate.companyName,
        signatoryUserId: done.corporate.signatory.userId,
        activeMemberGhIds: done.affectedGhIds,
      };
    },
    async rejectCorporate(a) {
      const done = await call<{ corporate: LegalCorporateView }>(
        "POST",
        `corporate/${encodeURIComponent(a.corporateId)}/reject`,
        { reason: a.reason, ...actor(a.actorUserId) }
      );
      return {
        companyName: done.corporate.companyName,
        signatoryUserId: done.corporate.signatory.userId,
      };
    },
    async revokeCorporate(a) {
      const done = await call<{ corporate: LegalCorporateView; affectedGhIds: number[] }>(
        "POST",
        `corporate/${encodeURIComponent(a.corporateId)}/revoke`,
        actor(a.actorUserId)
      );
      return { companyName: done.corporate.companyName, affectedGhIds: done.affectedGhIds };
    },

    async rosterMember(id) {
      const view = await orNull(call<LegalRosterView>("GET", `roster/${encodeURIComponent(id)}`));
      return view === null ? null : rosterRow(projectId, view);
    },
    async roster(q) {
      const corporates = q.corporateIds ?? [undefined];
      const rows: ClaRosterRow[] = [];
      for (const corporateId of corporates) {
        const query = [
          param("corporateId", corporateId),
          param("status", q.status),
          param("ghId", q.ghId),
          param("ghLogin", q.ghLogin),
        ]
          .join("")
          .replace(/^&/u, "");
        const all = await legalAll<LegalRosterView>(projectId, "roster", query);
        rows.push(...all.map((one) => rosterRow(projectId, one)));
      }
      return rows;
    },
    addRosterMembers: (a) =>
      call("POST", `corporate/${encodeURIComponent(a.corporateId)}/roster`, {
        entries: a.entries.map((one) => ({ ghLogin: one.ghLogin, ghId: one.ghId ?? null })),
        ...actor(a.actorUserId),
      }),
    async revokeRosterMember(a) {
      await call("POST", `roster/${encodeURIComponent(a.memberId)}/revoke`, actor(a.actorUserId));
    },
    async disputeRosterMembership(a) {
      await call("POST", `roster/${encodeURIComponent(a.memberId)}/dispute`, {
        note: a.note ?? null,
        ...actor(a.actorUserId, a.actorGhId),
      });
    },

    async waiver(id) {
      const view = await orNull(call<LegalWaiverView>("GET", `waivers/${encodeURIComponent(id)}`));
      return view === null ? null : waiverRow(projectId, view);
    },
    async waivers(q) {
      const page = await call<LegalPage<LegalWaiverView>>(
        "GET",
        `waivers?${pageOf(q)}${param("q", q.q)}`
      );
      return { items: page.items.map((one) => waiverRow(projectId, one)), total: page.total };
    },
    grantWaiver: (a) =>
      call("POST", "waivers", {
        ghLogin: a.ghLogin.trim(),
        ghId: a.ghId ?? null,
        reason: a.reason,
        ...actor(a.actorUserId),
      }),
    async revokeWaiver(a) {
      await call("POST", `waivers/${encodeURIComponent(a.waiverId)}/revoke`, actor(a.actorUserId));
    },

    status: (a) => getClaStatus({ projectId, ...a }),

    async events(q) {
      const page = await call<LegalPage<LegalEventView>>(
        "GET",
        `events?${pageOf(q)}&order=${q.order ?? "desc"}`
      );
      return { items: page.items.map(eventRow), total: page.total };
    },
    verify: () => call<ChainVerifyResult>("GET", "verify"),
  };
}
