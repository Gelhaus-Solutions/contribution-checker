"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/authz";
import { setOrgPermission } from "@/lib/auth/sync-user";
import { CREATE_PROJECT_PERMISSION, SUPER_ADMIN_PERMISSION } from "@/lib/stack";

// Org roles live in Hexclave (source of truth). These actions write the
// Hexclave project permission for linked users, then mirror the local
// isSuperAdmin/canCreateProj cache columns the hot path reads. Users not yet
// linked to Hexclave (no stackUserId) get the column set now; reconcileOrgPermissions
// propagates it to Hexclave on their first sign-in.

const grantSchema = z.object({
  ghLogin: z.string().min(1).max(80),
});

export async function grantCreatorByGhLogin(formData: FormData) {
  await requireSuperAdmin();
  const parsed = grantSchema.parse({
    ghLogin: String(formData.get("ghLogin") ?? "").trim(),
  });
  const user = await prisma.user.findUnique({
    where: { ghLogin: parsed.ghLogin },
    select: { id: true, stackUserId: true },
  });
  if (!user) {
    throw new Error(
      `No user with GitHub login "${parsed.ghLogin}" has signed in yet.`
    );
  }
  if (user.stackUserId) {
    await setOrgPermission(user.stackUserId, CREATE_PROJECT_PERMISSION, true);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { canCreateProj: true },
  });
  revalidatePath("/admin/allowlist");
}

const idSchema = z.object({ userId: z.string().min(1) });

export async function revokeCreator(formData: FormData) {
  await requireSuperAdmin();
  const { userId } = idSchema.parse({ userId: formData.get("userId") });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stackUserId: true },
  });
  if (user?.stackUserId) {
    await setOrgPermission(user.stackUserId, CREATE_PROJECT_PERMISSION, false);
  }
  await prisma.user.update({
    where: { id: userId },
    data: { canCreateProj: false },
  });
  revalidatePath("/admin/allowlist");
}

export async function toggleSuperAdmin(formData: FormData) {
  const session = await requireSuperAdmin();
  const { userId } = idSchema.parse({ userId: formData.get("userId") });
  if (userId === session.user.id) {
    throw new Error("Cannot toggle your own super-admin status.");
  }
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { isSuperAdmin: true, stackUserId: true },
  });
  if (!u) throw new Error("User not found");
  const next = !u.isSuperAdmin;
  if (u.stackUserId) {
    await setOrgPermission(u.stackUserId, SUPER_ADMIN_PERMISSION, next);
    // Granting super always grants creator; revoking super preserves creator.
    if (next) {
      await setOrgPermission(u.stackUserId, CREATE_PROJECT_PERMISSION, true);
    }
  }
  await prisma.user.update({
    where: { id: userId },
    data: {
      isSuperAdmin: next,
      ...(next ? { canCreateProj: true } : {}),
    },
  });
  revalidatePath("/admin/allowlist");
}
