import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers, notifyUser } from "@/lib/notifications/inbox";
import { applyUrl, dashboardUrl, sendEmail } from "@/lib/notifications/email";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";

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
      project: { select: { id: true, name: true, slug: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: {
      status: "APPROVED",
      decidedById: args.decidedById,
      decidedAt: new Date(),
      reason: args.reason,
    },
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
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: {
      status: "DENIED",
      decidedById: args.decidedById,
      decidedAt: new Date(),
      reason: args.reason,
    },
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

export async function revokeApplication(args: {
  applicationId: string;
  decidedById: string;
  reason?: string;
}) {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      user: { select: { ghLogin: true } },
    },
  });
  if (!app) throw new Error("Application not found");

  const updated = await prisma.application.update({
    where: { id: args.applicationId },
    data: {
      status: "REVOKED",
      decidedById: args.decidedById,
      decidedAt: new Date(),
      reason: args.reason,
    },
  });

  await recordAudit({
    projectId: app.projectId,
    actorId: args.decidedById,
    kind: "application.revoked",
    payload: { applicationId: app.id, applicantId: app.userId },
  });
  await notifyUser({
    userId: app.userId,
    kind: "application.revoked",
    payload: {
      projectId: app.projectId,
      projectSlug: app.project.slug,
      projectName: app.project.name,
      reason: args.reason ?? null,
    },
  });
  await emailUser({
    userId: app.userId,
    subject: `Approval revoked: ${app.project.name}`,
    text:
      `Your contributor approval for ${app.project.name} has been revoked.` +
      (args.reason ? `\n\nReason: ${args.reason}` : "") +
      `\n`,
  });
  await enqueueProjectWebhook({
    projectId: app.projectId,
    event: "application.revoked",
    payload: {
      applicationId: app.id,
      ghLogin: app.user.ghLogin,
      reason: args.reason ?? null,
    },
    triggeredById: args.decidedById,
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
