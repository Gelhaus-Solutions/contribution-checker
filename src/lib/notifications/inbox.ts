import type { Notification, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type NotificationKind =
  | "application.submitted"
  | "application.approved"
  | "application.denied"
  | "application.revoked"
  | "application.note_added"
  | "application.review_submitted"
  | "application.comment_replied"
  | "application.awaiting_review"
  | "application.appeal_submitted"
  | "application.appeal_rejected"
  | "application.resubmit_allowed"
  | "project.invited"
  | "pr.blocked"
  | "cla.ccla_signed"
  | "cla.ccla_approved"
  | "cla.ccla_rejected"
  | "cla.roster_changed"
  | "cla.roster_disputed"
  | "cla.resign_required"
  | "cla.pending_change"
  | "cla.signature_required"
  | "qa.items_added"
  | "qa.batch_ready";

/** Human labels for notification kinds (shared by the inbox page + the bell). */
export const KIND_LABELS: Record<string, string> = {
  "application.submitted": "New application",
  "application.approved": "Application approved",
  "application.denied": "Application denied",
  "application.revoked": "Approval revoked",
  "application.note_added": "Note added",
  "application.awaiting_review": "Application awaiting review",
  "application.appeal_submitted": "Appeal submitted",
  "application.appeal_rejected": "Appeal declined",
  "project.invited": "Invited to a project",
  "pr.blocked": "PR blocked",
  "qa.items_added": "New work in a verified batch",
  "qa.batch_ready": "Release batch is verified",
  "cla.ccla_signed": "Corporate CLA signed",
  "cla.ccla_approved": "Corporate CLA approved",
  "cla.ccla_rejected": "Corporate CLA rejected",
  "cla.roster_changed": "Corporate CLA roster changed",
  "cla.roster_disputed": "Corporate CLA membership disputed",
  "cla.signature_required": "Sign the CLA",
  "cla.resign_required": "Re-sign the CLA",
};

/** Tolerant parse of a notification's JSON payload (never throws). */
export function parseNotificationPayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Resolve the click-through href for a notification (shared by page + bell). */
export function notificationHref(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  const str = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string) : null;
  const projectId = str("projectId");
  const projectSlug = str("projectSlug");
  const applicationId = str("applicationId");

  if (
    (kind === "application.submitted" ||
      kind === "application.appeal_submitted") &&
    projectId &&
    applicationId
  ) {
    return `/dashboard/projects/${projectId}/applications/${applicationId}`;
  }
  if (kind === "project.invited" && projectId) {
    return `/dashboard/projects/${projectId}`;
  }
  if (kind.startsWith("qa.") && projectId) {
    const repoId = str("repoId");
    return repoId
      ? `/dashboard/projects/${projectId}/qa?repo=${repoId}`
      : `/dashboard/projects/${projectId}/qa`;
  }
  if (
    (kind === "cla.signature_required" || kind === "cla.resign_required") &&
    projectSlug
  ) {
    return `/p/${projectSlug}/cla`;
  }
  return projectSlug ? `/p/${projectSlug}` : null;
}

export type RecentNotification = {
  id: string;
  label: string;
  href: string | null;
  createdAt: string;
  read: boolean;
};

/**
 * A small, serializable preview of the latest notifications + the unread count,
 * for the header notification bell. Read-only (does not mark anything read).
 */
export async function getRecentNotifications(
  userId: string,
  take = 8,
): Promise<{ items: RecentNotification[]; unread: number }> {
  const [{ items }, unread] = await Promise.all([
    listNotifications(userId, { take }),
    unreadCount(userId),
  ]);
  return {
    unread,
    items: items.map((n) => {
      const payload = parseNotificationPayload(n.payload);
      return {
        id: n.id,
        label: KIND_LABELS[n.kind] ?? n.kind,
        href: notificationHref(n.kind, payload),
        createdAt: n.createdAt.toISOString(),
        read: !!n.readAt,
      };
    }),
  };
}

export async function notifyUser(args: {
  userId: string;
  kind: NotificationKind;
  payload?: Record<string, unknown>;
}) {
  return prisma.notification.create({
    data: {
      userId: args.userId,
      kind: args.kind,
      payload: JSON.stringify(args.payload ?? {}),
    },
  });
}

export async function notifyProjectReviewers(args: {
  projectId: string;
  excludeUserId?: string;
  kind: NotificationKind;
  payload?: Record<string, unknown>;
}) {
  const members = await prisma.projectMember.findMany({
    where: {
      projectId: args.projectId,
      role: { in: ["OWNER", "ADMIN", "REVIEWER"] },
      ...(args.excludeUserId ? { NOT: { userId: args.excludeUserId } } : {}),
    },
    select: { userId: true },
  });
  if (members.length === 0) return;
  await prisma.notification.createMany({
    data: members.map((m) => ({
      userId: m.userId,
      kind: args.kind,
      payload: JSON.stringify(args.payload ?? {}),
    })),
  });
}

export async function listNotifications(
  userId: string,
  opts?: { skip?: number; take?: number; q?: string },
): Promise<{ items: Notification[]; total: number }> {
  const q = opts?.q?.trim();
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(q ? { kind: { contains: q, mode: "insensitive" } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: opts?.skip ?? 0,
      take: opts?.take ?? 25,
    }),
    prisma.notification.count({ where }),
  ]);
  return { items, total };
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({
    where: { userId, readAt: null },
  });
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markRead(userId: string, id: string) {
  await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
  });
}
