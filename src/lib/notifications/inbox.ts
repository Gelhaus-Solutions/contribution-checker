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
  | "project.invited"
  | "pr.blocked"
  | "cla.ccla_signed"
  | "cla.ccla_approved"
  | "cla.ccla_rejected"
  | "cla.roster_changed"
  | "cla.roster_disputed"
  | "cla.resign_required"
  | "cla.pending_change";

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
  opts?: { skip?: number; take?: number; q?: string }
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
