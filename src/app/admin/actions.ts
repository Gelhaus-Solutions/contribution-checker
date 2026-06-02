"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/authz";
import { provisionStackAuth } from "@/lib/stack-provisioning";

/**
 * Reconcile the Stack Auth project permission definitions and one-time seed the
 * Instance Admin team. Idempotent: safe to click repeatedly (e.g. after the
 * permission catalog changes). Bootstrap of the very first admin is normally
 * done by the CLI script; this is the in-app re-provisioning trigger.
 */
export async function provisionStackAuthAction() {
  const session = await requireSuperAdmin();
  await provisionStackAuth(session.user.id);
  revalidatePath("/admin");
}
