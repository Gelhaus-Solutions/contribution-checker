import { prisma } from "@/lib/db";

/**
 * Self-service data export (GDPR Art. 15 and 20): everything the app holds
 * about one signed-in user, as plain JSON-serialisable data.
 *
 * Every query is an explicit `select`, never a bare row, so a column added to a
 * model later is NOT exported until it is listed here and judged. Internal
 * secrets and credentials are never selected: no QA board token or API key, no
 * webhook secret (those are project secrets, encrypted at rest), no Hexclave
 * link, no raw model prompts or raw model output. Other people appear only as a
 * GitHub login (a reviewer, a decider), never by internal id or email.
 */

export const ACCOUNT_EXPORT_FORMAT = "contribution-checker-account-export/1";

/** Parse a JSON text column; fall back to the raw string rather than losing it. */
function parseJson(text: string | null | undefined): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type Login = { ghLogin: string | null } | null;
const login = (u: Login) => u?.ghLogin ?? null;

export async function buildAccountExport(
  userId: string,
  now: Date = new Date(),
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      ghId: true,
      ghLogin: true,
      country: true,
      isSuperAdmin: true,
      canCreateProj: true,
      createdAt: true,
    },
  });
  if (!user) return null;

  const { ghId, ghLogin } = user;
  // Rows that key on the GitHub identity rather than the user id.
  const byGhId = ghId != null ? [{ ghId }] : [];
  const byGhLogin = ghLogin
    ? [{ ghLogin: { equals: ghLogin, mode: "insensitive" as const } }]
    : [];

  const [
    memberships,
    applications,
    signatures,
    rosterEntries,
    waivers,
    prChecks,
    notifications,
    termsAcceptances,
  ] = await Promise.all([
    prisma.projectMember.findMany({
      where: { userId },
      select: {
        role: true,
        permissions: true,
        createdAt: true,
        project: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.application.findMany({
      where: { userId },
      select: {
        id: true,
        status: true,
        answers: true,
        reason: true,
        decidedAt: true,
        allowResubmit: true,
        cooldownUntil: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { id: true, slug: true, name: true } },
        decidedBy: { select: { ghLogin: true } },
        appeal: {
          select: {
            id: true,
            status: true,
            message: true,
            answers: true,
            resolvedAt: true,
            resolutionNote: true,
            createdAt: true,
            updatedAt: true,
            resolvedBy: { select: { ghLogin: true } },
          },
        },
        notes: {
          select: {
            id: true,
            parentId: true,
            reviewId: true,
            fieldId: true,
            visibility: true,
            body: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
            author: { select: { ghLogin: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        reviews: {
          select: {
            id: true,
            state: true,
            body: true,
            visibility: true,
            submittedAt: true,
            updatedAt: true,
            deletedAt: true,
            author: { select: { ghLogin: true } },
          },
          orderBy: { submittedAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.claSignature.findMany({
      where: { OR: [{ userId }, ...byGhId] },
      select: {
        id: true,
        kind: true,
        ghId: true,
        ghLogin: true,
        emailSnapshot: true,
        legalName: true,
        affirmation: true,
        agreed: true,
        documentVersion: true,
        contentHash: true,
        signatureKind: true,
        signatureText: true,
        // A data URL: already base64, exported as stored.
        signatureImage: true,
        ip: true,
        userAgent: true,
        applicationId: true,
        customFields: true,
        status: true,
        revokedAt: true,
        revokeReason: true,
        signedAt: true,
        project: { select: { id: true, slug: true, name: true } },
        corporateSignatory: {
          select: {
            id: true,
            companyName: true,
            registeredAddress: true,
            country: true,
            contactName: true,
            contactEmail: true,
            signatoryTitle: true,
            signatureText: true,
            status: true,
            createdAt: true,
          },
        },
      },
      orderBy: { signedAt: "asc" },
    }),
    prisma.cclaRosterMember.findMany({
      where: { OR: [...byGhId, ...byGhLogin] },
      select: {
        id: true,
        ghLogin: true,
        ghId: true,
        status: true,
        addedAt: true,
        revokedAt: true,
        disputedAt: true,
        disputeNote: true,
        project: { select: { id: true, slug: true, name: true } },
        corporateCla: { select: { companyName: true } },
      },
      orderBy: { addedAt: "asc" },
    }),
    prisma.claWaiver.findMany({
      where: { OR: [...byGhId, ...byGhLogin] },
      select: {
        id: true,
        ghLogin: true,
        ghId: true,
        reason: true,
        status: true,
        grantedAt: true,
        revokedAt: true,
        project: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { grantedAt: "asc" },
    }),
    prisma.prCheck.findMany({
      where: {
        OR: [
          ...byGhId.map((g) => ({ authorGhId: g.ghId })),
          ...(ghLogin
            ? [{ authorGhLogin: { equals: ghLogin, mode: "insensitive" as const } }]
            : []),
        ],
      },
      select: {
        id: true,
        prNumber: true,
        authorGhLogin: true,
        authorGhId: true,
        status: true,
        closedByApp: true,
        gateReason: true,
        headSha: true,
        createdAt: true,
        updatedAt: true,
        repo: { select: { fullName: true } },
        quality: { select: { signalsRaw: true, computedAt: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.notification.findMany({
      where: { userId },
      select: {
        id: true,
        kind: true,
        payload: true,
        readAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.termsAcceptance.findMany({
      where: { userId },
      select: { version: true, source: true, acceptedAt: true },
      orderBy: { acceptedAt: "asc" },
    }),
  ]);

  const signatureIds = signatures.map((s) => s.id);
  const rosterIds = rosterEntries.map((r) => r.id);
  const waiverIds = waivers.map((w) => w.id);
  const applicationIds = applications.map((a) => a.id);
  const prCheckIds = prChecks.map((p) => p.id);

  const ledgerWhere = [
    { actorUserId: userId },
    ...(ghId != null ? [{ actorGhId: ghId }] : []),
    ...(signatureIds.length ? [{ signatureId: { in: signatureIds } }] : []),
    ...(rosterIds.length ? [{ rosterMemberId: { in: rosterIds } }] : []),
    ...(waiverIds.length ? [{ waiverId: { in: waiverIds } }] : []),
  ];
  const aiSubjects = [
    ...applicationIds.map((id) => `application:${id}`),
    ...prCheckIds.map((id) => `prcheck:${id}`),
  ];

  const [ledgerEvents, auditEvents, aiResults] = await Promise.all([
    prisma.claEventLog.findMany({
      where: { OR: ledgerWhere },
      select: {
        seq: true,
        kind: true,
        payload: true,
        actorGhId: true,
        entryHash: true,
        prevHash: true,
        createdAt: true,
        project: { select: { id: true, slug: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    // The user is the actor, or the subject: audit payloads name the affected
    // person by their (unguessable) cuid, so a substring match is exact.
    prisma.auditEvent.findMany({
      where: {
        OR: [{ actorId: userId }, { payload: { contains: userId } }],
      },
      select: {
        id: true,
        projectId: true,
        actorId: true,
        kind: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    aiSubjects.length
      ? prisma.aiResult.findMany({
          where: { subjectKey: { in: aiSubjects } },
          // No inputHash, rawOutput, error text or token and cost counters.
          select: {
            id: true,
            projectId: true,
            taskId: true,
            subjectKey: true,
            status: true,
            output: true,
            modelId: true,
            createdAt: true,
            completedAt: true,
          },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    user,
    memberships: memberships.map((m) => ({
      project: m.project,
      role: m.role,
      permissions: parseJson(m.permissions),
      since: m.createdAt,
    })),
    applications: applications.map((a) => ({
      id: a.id,
      project: a.project,
      status: a.status,
      answers: parseJson(a.answers),
      decision: {
        decidedAt: a.decidedAt,
        decidedBy: login(a.decidedBy),
        reason: a.reason,
        allowResubmit: a.allowResubmit,
        cooldownUntil: a.cooldownUntil,
      },
      appeal: a.appeal
        ? {
            id: a.appeal.id,
            status: a.appeal.status,
            message: a.appeal.message,
            answers: parseJson(a.appeal.answers),
            resolvedAt: a.appeal.resolvedAt,
            resolvedBy: login(a.appeal.resolvedBy),
            resolutionNote: a.appeal.resolutionNote,
            createdAt: a.appeal.createdAt,
            updatedAt: a.appeal.updatedAt,
          }
        : null,
      notes: a.notes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        reviewId: n.reviewId,
        fieldId: n.fieldId,
        visibility: n.visibility,
        // A soft-deleted note is a tombstone in the product; keep it that way.
        body: n.deletedAt ? null : n.body,
        author: login(n.author),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        deletedAt: n.deletedAt,
      })),
      reviews: a.reviews.map((r) => ({
        id: r.id,
        state: r.state,
        body: r.deletedAt ? null : r.body,
        visibility: r.visibility,
        reviewer: login(r.author),
        submittedAt: r.submittedAt,
        updatedAt: r.updatedAt,
        dismissedAt: r.deletedAt,
      })),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    cla: {
      signatures: signatures.map((s) => ({
        ...s,
        customFields: parseJson(s.customFields),
      })),
      corporateRosterEntries: rosterEntries.map((r) => ({
        id: r.id,
        project: r.project,
        company: r.corporateCla.companyName,
        ghLogin: r.ghLogin,
        ghId: r.ghId,
        status: r.status,
        addedAt: r.addedAt,
        revokedAt: r.revokedAt,
        disputedAt: r.disputedAt,
        disputeNote: r.disputeNote,
      })),
      waivers,
      ledgerEvents: ledgerEvents.map((e) => ({
        ...e,
        payload: parseJson(e.payload),
      })),
    },
    prChecks: prChecks.map((p) => ({
      id: p.id,
      repo: p.repo.fullName,
      prNumber: p.prNumber,
      authorGhLogin: p.authorGhLogin,
      authorGhId: p.authorGhId,
      status: p.status,
      closedByApp: p.closedByApp,
      gateReason: p.gateReason,
      headSha: p.headSha,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      quality: p.quality
        ? {
            signals: parseJson(p.quality.signalsRaw),
            computedAt: p.quality.computedAt,
          }
        : null,
    })),
    notifications: notifications.map((n) => ({
      ...n,
      payload: parseJson(n.payload),
    })),
    auditEvents: auditEvents.map((e) => ({
      ...e,
      payload: parseJson(e.payload),
    })),
    aiResults: aiResults.map((r) => ({
      ...r,
      output: parseJson(r.output),
    })),
    termsAcceptances,
  };
}
