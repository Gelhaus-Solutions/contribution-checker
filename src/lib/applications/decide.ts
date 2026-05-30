import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers, notifyUser } from "@/lib/notifications/inbox";
import { applyUrl, dashboardUrl, sendEmail } from "@/lib/notifications/email";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import { isClaSatisfied } from "@/lib/cla/status";

function recordApplicationDecisionMetric(
  outcome: "approved" | "denied" | "revoked",
  attrs: { projectId: string; projectSlug?: string; reason?: string | null },
): void {
  Sentry.metrics.count("application.decision", 1, {
    attributes: {
      outcome,
      "project.id": attrs.projectId,
      "project.slug": attrs.projectSlug ?? "",
      "decision.has_reason": Boolean(attrs.reason),
    },
  });
}

/** Thrown by approveApplication when the project's review gate is not met. */
export class ApprovalGateError extends Error {
  constructor(
    public readonly required: number,
    public readonly have: number,
  ) {
    super(`approval_gate_blocked: have ${have}, need ${required}`);
    this.name = "ApprovalGateError";
  }
}

/**
 * Thrown by approveApplication when the project requires a CLA
 * (`claEnabled && claRequired`) and the applicant has not yet satisfied it.
 * Surfaced as a friendly banner in the application review UI.
 */
export class ClaGateError extends Error {
  constructor() {
    super("cla_gate_blocked: applicant must sign the CLA before approval");
    this.name = "ClaGateError";
  }
}

/**
 * Count distinct authors who have submitted an APPROVED review on this
 * application, excluding `excludeUserId` (the actor, since reviewers can't
 * self-approve toward the gate). Soft-dismissed reviews don't count.
 */
export async function countApprovingReviewers(args: {
  applicationId: string;
  excludeUserId: string;
}): Promise<number> {
  const rows = await prisma.applicationReview.findMany({
    where: {
      applicationId: args.applicationId,
      state: "APPROVED",
      deletedAt: null,
      authorId: { not: args.excludeUserId },
    },
    select: { authorId: true },
  });
  const distinct = new Set(rows.map((r) => r.authorId));
  return distinct.size;
}

async function emailUser(args: {
  userId: string;
  subject: string;
  text: string;
}) {
  const u = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { email: true },
  });
  if (!u?.email) return;
  await sendEmail({ to: u.email, subject: args.subject, text: args.text });
}

async function emailProjectReviewers(args: {
  projectId: string;
  excludeUserId?: string;
  subject: string;
  text: string;
}) {
  const members = await prisma.projectMember.findMany({
    where: {
      projectId: args.projectId,
      role: { in: ["OWNER", "ADMIN", "REVIEWER"] },
      ...(args.excludeUserId ? { NOT: { userId: args.excludeUserId } } : {}),
      user: { email: { not: null } },
    },
    select: { user: { select: { email: true } } },
  });
  const recipients = members
    .map((m) => m.user.email)
    .filter((e): e is string => !!e);
  for (const to of recipients) {
    await sendEmail({ to, subject: args.subject, text: args.text });
  }
}

export async function approveApplication(args: {
  applicationId: string;
  decidedById: string;
  reason?: string;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          slug: true,
          requireApprovalCount: true,
          claEnabled: true,
          claRequired: true,
        },
      },
      user: { select: { ghId: true, ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  // PR-style approval gate: require N distinct LGTMs from other reviewers
  // before this approval is allowed. Skipped when requireApprovalCount=0.
  if (app.project.requireApprovalCount > 0) {
    const have = await countApprovingReviewers({
      applicationId: app.id,
      excludeUserId: args.decidedById,
    });
    if (have < app.project.requireApprovalCount) {
      throw new ApprovalGateError(app.project.requireApprovalCount, have);
    }
  }

  // CLA gate: when the project requires a CLA, the applicant must have
  // satisfied it (ICLA / CCLA roster / waiver) before approval is allowed.
  if (app.project.claEnabled && app.project.claRequired) {
    const satisfied =
      app.user.ghId != null &&
      app.user.ghLogin != null &&
      (await isClaSatisfied({
        projectId: app.projectId,
        ghId: app.user.ghId,
        ghLogin: app.user.ghLogin,
      }));
    if (!satisfied) {
      throw new ClaGateError();
    }
  }

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: {
      status: "APPROVED",
      decidedById: args.decidedById,
      decidedAt: new Date(),
      reason: args.reason,
      allowResubmit: true,
      cooldownUntil: null,
    },
  });

  recordApplicationDecisionMetric("approved", {
    projectId: app.projectId,
    projectSlug: app.project.slug,
    reason: args.reason,
  });
  await recordAudit({
    projectId: app.projectId,
    actorId: args.decidedById,
    kind: "application.approved",
    payload: { applicationId: app.id, applicantId: app.userId },
  });
  await notifyUser({
    userId: app.userId,
    kind: "application.approved",
    payload: {
      projectId: app.projectId,
      projectSlug: app.project.slug,
      projectName: app.project.name,
    },
  });
  await emailUser({
    userId: app.userId,
    subject: `Approved: ${app.project.name}`,
    text:
      `Your application for ${app.project.name} was approved.\n\n` +
      `You can now open pull requests on the linked repositories.\n\n` +
      `${applyUrl(app.project.slug)}\n`,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.approved",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
      reason: args.reason ?? null,
    },
    triggeredById: args.decidedById,
  });

  return updated;
}

export async function denyApplication(args: {
  applicationId: string;
  decidedById: string;
  reason?: string;
  allowResubmit: boolean;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true, cooldownDays: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  const cooldownUntil =
    args.allowResubmit && app.project.cooldownDays != null
      ? new Date(Date.now() + app.project.cooldownDays * 24 * 60 * 60 * 1000)
      : null;

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: {
      status: "DENIED",
      decidedById: args.decidedById,
      decidedAt: new Date(),
      reason: args.reason,
      allowResubmit: args.allowResubmit,
      cooldownUntil,
    },
  });

  recordApplicationDecisionMetric("denied", {
    projectId: app.projectId,
    projectSlug: app.project.slug,
    reason: args.reason,
  });
  await recordAudit({
    projectId: app.projectId,
    actorId: args.decidedById,
    kind: "application.denied",
    payload: { applicationId: app.id, applicantId: app.userId },
  });
  await notifyUser({
    userId: app.userId,
    kind: "application.denied",
    payload: {
      projectId: app.projectId,
      projectSlug: app.project.slug,
      projectName: app.project.name,
      reason: args.reason ?? null,
    },
  });
  await emailUser({
    userId: app.userId,
    subject: `Application declined: ${app.project.name}`,
    text:
      `Your application for ${app.project.name} was declined.` +
      (args.reason ? `\n\nReason: ${args.reason}` : "") +
      `\n\n${applyUrl(app.project.slug)}\n`,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.denied",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
      reason: args.reason ?? null,
    },
    triggeredById: args.decidedById,
  });

  return updated;
}

export type RevokeTarget = "DENIED" | "SUBMITTED" | "PENDING";

export async function revokeApplication(args: {
  applicationId: string;
  decidedById: string;
  reason?: string;
  target: RevokeTarget;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true, cooldownDays: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  const now = new Date();
  let data: {
    status: "DENIED" | "SUBMITTED";
    decidedById: string | null;
    decidedAt: Date | null;
    reason: string | null;
    allowResubmit: boolean;
    cooldownUntil: Date | null;
  };
  if (args.target === "DENIED") {
    data = {
      status: "DENIED",
      decidedById: args.decidedById,
      decidedAt: now,
      reason: args.reason ?? null,
      allowResubmit: true,
      cooldownUntil:
        app.project.cooldownDays != null
          ? new Date(now.getTime() + app.project.cooldownDays * 24 * 60 * 60 * 1000)
          : null,
    };
  } else if (args.target === "PENDING") {
    data = {
      status: "DENIED",
      decidedById: args.decidedById,
      decidedAt: now,
      reason: args.reason ?? null,
      allowResubmit: true,
      cooldownUntil: null,
    };
  } else {
    // target === "SUBMITTED": send back to review queue, clear decision metadata.
    data = {
      status: "SUBMITTED",
      decidedById: null,
      decidedAt: null,
      reason: args.reason ?? null,
      allowResubmit: true,
      cooldownUntil: null,
    };
  }

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data,
  });

  recordApplicationDecisionMetric("revoked", {
    projectId: app.projectId,
    projectSlug: app.project.slug,
    reason: args.reason,
  });
  await recordAudit({
    projectId: app.projectId,
    actorId: args.decidedById,
    kind: "application.revoked",
    payload: {
      applicationId: app.id,
      applicantId: app.userId,
      target: args.target,
    },
  });
  await notifyUser({
    userId: app.userId,
    kind: "application.revoked",
    payload: {
      projectId: app.projectId,
      projectSlug: app.project.slug,
      projectName: app.project.name,
      reason: args.reason ?? null,
      target: args.target,
    },
  });
  const followUp =
    args.target === "PENDING"
      ? `\n\nYou may submit a new application at any time: ${applyUrl(app.project.slug)}\n`
      : args.target === "SUBMITTED"
        ? `\n\nYour application has been put back under review.\n`
        : `\n`;
  await emailUser({
    userId: app.userId,
    subject: `Approval revoked: ${app.project.name}`,
    text:
      `Your contributor approval for ${app.project.name} has been revoked.` +
      (args.reason ? `\n\nReason: ${args.reason}` : "") +
      followUp,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.revoked",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
      reason: args.reason ?? null,
      target: args.target,
    },
    triggeredById: args.decidedById,
  });

  if (args.target === "SUBMITTED") {
    await notifyAdminsOfNewApplication({ applicationId: app.id });
  }

  return updated;
}

export async function notifyAdminsOfNewApplication(args: {
  applicationId: string;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      user: { select: { id: true, ghLogin: true } },
    },
  });
  if (!app) return;
  await notifyProjectReviewers({
    projectId: app.projectId,
    excludeUserId: app.userId,
    kind: "application.submitted",
    payload: {
      applicationId: app.id,
      projectId: app.projectId,
      projectSlug: app.project.slug,
      projectName: app.project.name,
      ghLogin: app.user.ghLogin,
    },
  });
  await emailProjectReviewers({
    projectId: app.projectId,
    excludeUserId: app.userId,
    subject: `[${app.project.name}] New application from @${app.user.ghLogin ?? "unknown"}`,
    text:
      `A new application was submitted for ${app.project.name}.\n\n` +
      `From: @${app.user.ghLogin ?? "(unknown)"}\n\n` +
      `Review: ${dashboardUrl(`/dashboard/projects/${app.projectId}/applications/${app.id}`)}\n`,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.submitted",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
    },
    triggeredById: app.userId,
  });
}
