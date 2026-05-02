"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import { markAllRead } from "@/lib/notifications/inbox";

export async function markAllReadAction() {
  const session = await requireSession();
  await markAllRead(session.user.id);
  revalidatePath("/dashboard/notifications");
  revalidatePath("/dashboard");
}
