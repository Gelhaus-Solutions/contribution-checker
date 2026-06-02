"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/authz";
import { setOrgPermission } from "@/lib/auth/sync-user";
import { ensureInstanceAdminTeam } from "@/lib/stack-provisioning";
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
  if (!u.stackUserId) {
    throw new Error(
      "This user must sign in once before their super-admin status can be changed."
    );
  }
  const next = !u.isSuperAdmin;

  // Super-admin is membership in the Instance Admin team (the live authority).
  const team = await ensureInstanceAdminTeam();
  if (next) {
    await team.addUser(u.stackUserId);
    await setOrgPermission(u.stackUserId, CREATE_PROJECT_PERMISSION, true);
  } else {
    await team.removeUser(u.stackUserId);
    // Also revoke any break-glass global super_admin grant so revocation sticks
    // (the cache is then re-mirrored from the live team membership by auth()).
    await setOrgPermission(u.stackUserId, SUPER_ADMIN_PERMISSION, false);
  }

  await recordAudit({
    projectId: null,
    actorId: session.user.id,
    kind: next ? "user.superadmin_granted" : "user.superadmin_revoked",
    payload: { userId },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      isSuperAdmin: next,
      ...(next ? { canCreateProj: true } : {}),
    },
  });
  revalidatePath("/admin/allowlist");
}
