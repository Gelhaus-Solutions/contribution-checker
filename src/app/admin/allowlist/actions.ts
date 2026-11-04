"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/authz";

// Org roles are this app's own columns since the move off Hexclave:
// User.isSuperAdmin and User.canCreateProj are the truth, read on the hot path
// by auth(). SUPER_ADMINS and PROJECT_CREATORS only seed them, once, when an
// account first gets its GitHub login (src/lib/auth/sync-user.ts), so what is
// changed here sticks.

const grantSchema = z.object({
  ghLogin: z.string().min(1).max(80),
});

export async function grantCreatorByGhLogin(formData: FormData) {
  const session = await requireSuperAdmin();
  const parsed = grantSchema.parse({
    ghLogin: String(formData.get("ghLogin") ?? "").trim(),
  });
  const user = await prisma.user.findUnique({
    where: { ghLogin: parsed.ghLogin },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      `No user with GitHub login "${parsed.ghLogin}" has signed in yet.`
    );
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { canCreateProj: true },
  });
  await recordAudit({
    projectId: null,
    actorId: session.user.id,
    kind: "user.creator_granted",
    payload: { userId: user.id },
  });
  revalidatePath("/admin/allowlist");
}

const idSchema = z.object({ userId: z.string().min(1) });

export async function revokeCreator(formData: FormData) {
  const session = await requireSuperAdmin();
  const { userId } = idSchema.parse({ userId: formData.get("userId") });
  await prisma.user.update({
    where: { id: userId },
    data: { canCreateProj: false },
  });
  await recordAudit({
    projectId: null,
    actorId: session.user.id,
    kind: "user.creator_revoked",
    payload: { userId },
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
    select: { isSuperAdmin: true },
  });
  if (!u) throw new Error("User not found");
  const next = !u.isSuperAdmin;

  await prisma.user.update({
    where: { id: userId },
    data: {
      isSuperAdmin: next,
      // A super-admin can always create projects; revoking keeps what was granted.
      ...(next ? { canCreateProj: true } : {}),
    },
  });
  await recordAudit({
    projectId: null,
    actorId: session.user.id,
    kind: next ? "user.superadmin_granted" : "user.superadmin_revoked",
    payload: { userId },
  });
  revalidatePath("/admin/allowlist");
}
