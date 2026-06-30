import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers, notifyUser } from "@/lib/notifications/inbox";
import { applyUrl, dashboardUrl, sendEmail } from "@/lib/notifications/email";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import { startCooldownTimer } from "@/lib/temporal/start";
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

  // Durable cooldown timer: when the denial set a cooldown, a workflow sleeps
  // until it elapses and then proactively re-enables resubmission + notifies the
  // applicant (replacing on-read cooldown derivation). decideForRepo keeps its
  // own date check as a safety net.
  if (cooldownUntil) {
    await startCooldownTimer({
      applicationId: app.id,
      cooldownUntilIso: cooldownUntil.toISOString(),
    }).catch((e) =>
      // Don't fail the denial if Temporal is briefly unreachable; the date-based
      // safety net in decideForRepo still applies.
      Sentry.captureException(e, { tags: { component: "cooldown-timer" } })
    );
  }

  return updated;
}

/**
 * Manually re-open resubmission on an application that was denied with
 * `allowResubmit: false`. The application stays DENIED (we don't reopen any
 * PRs), but the contributor may submit a fresh application: `decideForRepo`
 * treats a DENIED-but-resubmittable app whose cooldown has elapsed as PENDING.
 *
 * The project's cooldown (if configured) is applied from now, mirroring the
 * "allow resubmit" path at deny time. Idempotent-ish: callers should only show
 * this for currently-blocked apps, but re-running it just refreshes the cooldown.
 */
export async function allowApplicationResubmit(args: {
  applicationId: string;
  decidedById: string;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true, cooldownDays: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");
  if (app.status !== "DENIED") {
    throw new Error(
      `Can only allow resubmitting on a DENIED application (status ${app.status}).`,
    );
  }

  const cooldownUntil =
    app.project.cooldownDays != null
      ? new Date(Date.now() + app.project.cooldownDays * 24 * 60 * 60 * 1000)
      : null;

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: { allowResubmit: true, cooldownUntil },
  });

  await recordAudit({
    projectId: app.projectId,
    actorId: args.decidedById,
    kind: "application.resubmit_allowed",
    payload: {
      applicationId: app.id,
      applicantId: app.userId,
      cooldownUntil: cooldownUntil?.toISOString() ?? null,
    },
  });

  // Tell the applicant they can re-apply. The denial reason stays out of this
  // message (it's already on their status page and the original denial email).
  const when = cooldownUntil
    ? `You may submit a new application on ${cooldownUntil.toISOString().slice(0, 10)}.`
    : `You may submit a new application now.`;
  await emailUser({
    userId: app.userId,
    subject: `You may re-apply: ${app.project.name}`,
    text:
      `A reviewer has re-opened resubmission for your ${app.project.name} application.\n\n` +
      `${when}\n\n` +
      `${applyUrl(app.project.slug)}\n`,
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

export type AppealResolution = "GRANT" | "ALLOW_RESUBMIT" | "REJECT";

const APPEAL_RESOLUTION_STATUS: Record<AppealResolution, string> = {
  GRANT: "GRANTED",
  ALLOW_RESUBMIT: "RESUBMIT_ALLOWED",
  REJECT: "REJECTED",
};

/**
 * Resolve a PENDING appeal on a DENIED application.
 *  - GRANT          -> approve the application (reusing approveApplication, so
 *                      the same approval-count / CLA gates apply and a gate
 *                      failure throws), then overwrite the application's answers
 *                      with the appeal's revised answers so the approved record
 *                      reflects what was reviewed.
 *  - ALLOW_RESUBMIT -> reuse allowApplicationResubmit (application stays DENIED).
 *  - REJECT         -> close the appeal; the application stays DENIED.
 *
 * GRANT and ALLOW_RESUBMIT delegate their applicant notify/email to
 * approveApplication / allowApplicationResubmit; only REJECT notifies here.
 * PR reopening on GRANT is the action layer's job (resolveAppealAction calls
 * onApplicationApproved), matching approveAction. A granted appeal therefore
 * emits both application.approved (from the delegate) and application.appeal_resolved;
 * webhook consumers should dedupe on applicationId.
 */
export async function resolveAppeal(args: {
  applicationId: string;
  resolution: AppealResolution;
  resolvedById: string;
  note?: string;
}) {
  const appeal = await prisma.applicationAppeal.findUnique({
    where: { applicationId: args.applicationId },
    include: {
      application: {
        include: {
          project: { select: { id: true, name: true, slug: true } },
          user: { select: { ghLogin: true } },
        },
      },
    },
  });
  if (!appeal) throw new Error("Appeal not found");
  if (appeal.status !== "PENDING") {
    throw new Error(`Appeal already resolved (status ${appeal.status}).`);
  }
  const app = appeal.application;
  const note = args.note?.trim() || undefined;

  if (args.resolution === "GRANT") {
    if (app.status !== "DENIED") {
      throw new Error(
        `Can only grant an appeal on a DENIED application (status ${app.status}).`,
      );
    }
    // May throw ApprovalGateError / ClaGateError; the action layer translates
    // these. Run it BEFORE touching answers so a gate failure leaves the
    // original answers (and the still-PENDING appeal) intact.
    await approveApplication({
      applicationId: app.id,
      decidedById: args.resolvedById,
      reason: note,
    });
    await prisma.application.update({
      where: { id: app.id },
      data: { answers: appeal.answers },
    });
  } else if (args.resolution === "ALLOW_RESUBMIT") {
    if (app.status !== "DENIED") {
      throw new Error(
        `Can only allow resubmit on a DENIED application (status ${app.status}).`,
      );
    }
    await allowApplicationResubmit({
      applicationId: app.id,
      decidedById: args.resolvedById,
    });
  }

  const updated = await prisma.applicationAppeal.update({
    where: { id: appeal.id },
    data: {
      status: APPEAL_RESOLUTION_STATUS[args.resolution],
      resolvedById: args.resolvedById,
      resolvedAt: new Date(),
      resolutionNote: note ?? null,
    },
  });

  if (args.resolution === "REJECT") {
    await notifyUser({
      userId: app.userId,
      kind: "application.appeal_rejected",
      payload: {
        projectId: app.projectId,
        projectSlug: app.project.slug,
        projectName: app.project.name,
        reason: note ?? null,
      },
    });
    await emailUser({
      userId: app.userId,
      subject: `Appeal declined: ${app.project.name}`,
      text:
        `Your appeal for ${app.project.name} was declined; your application remains denied.` +
        (note ? `\n\nNote: ${note}` : "") +
        `\n\n${applyUrl(app.project.slug)}\n`,
    });
  }

  await recordAudit({
    projectId: app.projectId,
    actorId: args.resolvedById,
    kind: "application.appeal_resolved",
    payload: {
      applicationId: app.id,
      appealId: appeal.id,
      resolution: args.resolution,
    },
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.appeal_resolved",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
      resolution: args.resolution,
      note: note ?? null,
    },
    triggeredById: args.resolvedById,
  });

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

/**
 * Tell project reviewers an appeal was filed (inbox + email + webhook). Mirrors
 * notifyAdminsOfNewApplication; called from the appeal action after submitAppeal.
 */
export async function notifyAdminsOfAppeal(args: { appealId: string }) {
  const appeal = await prisma.applicationAppeal.findUnique({
    where: { id: args.appealId },
    include: {
      application: {
        include: {
          project: { select: { id: true, name: true, slug: true } },
          user: { select: { id: true, ghLogin: true } },
        },
      },
    },
  });
  if (!appeal) return;
  const app = appeal.application;
  await notifyProjectReviewers({
    projectId: app.projectId,
    excludeUserId: app.userId,
    kind: "application.appeal_submitted",
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
    subject: `[${app.project.name}] Appeal from @${app.user.ghLogin ?? "unknown"}`,
    text:
      `@${app.user.ghLogin ?? "(unknown)"} appealed their declined application for ${app.project.name}.\n\n` +
      `Review the appeal: ${dashboardUrl(`/dashboard/projects/${app.projectId}/applications/${app.id}`)}\n`,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.appeal_submitted",
    payload: {
      applicationId: app.id,
      appealId: appeal.id,
      ghLogin: app.user.ghLogin,
    },
    triggeredById: app.userId,
  });
}
