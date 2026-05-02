"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/authz";

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
  revalidatePath("/admin/allowlist");
}

const idSchema = z.object({ userId: z.string().min(1) });

export async function revokeCreator(formData: FormData) {
  await requireSuperAdmin();
  const { userId } = idSchema.parse({ userId: formData.get("userId") });
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
    select: { isSuperAdmin: true },
  });
  if (!u) throw new Error("User not found");
  await prisma.user.update({
    where: { id: userId },
    data: {
      isSuperAdmin: !u.isSuperAdmin,
      // Granting super always grants creator; revoking super preserves creator flag.
      ...(u.isSuperAdmin ? {} : { canCreateProj: true }),
    },
  });
  revalidatePath("/admin/allowlist");
}
