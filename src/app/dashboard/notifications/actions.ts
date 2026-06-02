"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import {
  getRecentNotifications,
  markAllRead,
  type RecentNotification,
} from "@/lib/notifications/inbox";

export async function markAllReadAction() {
  const session = await requireSession();
  await markAllRead(session.user.id);
  revalidatePath("/dashboard/notifications");
  revalidatePath("/dashboard");
}

/** Read-only preview for the header notification bell (does not mark read). */
export async function fetchRecentNotifications(): Promise<{
  items: RecentNotification[];
  unread: number;
}> {
  const session = await requireSession();
  return getRecentNotifications(session.user.id, 8);
}
