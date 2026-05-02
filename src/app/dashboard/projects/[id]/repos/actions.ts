"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const addSchema = z.object({
  projectId: z.string().min(1),
  fullName: z
    .string()
    .min(3)
    .max(140)
    .transform((s) => s.trim())
    .refine(
      (s) => fullNamePattern.test(s),
      'Use the "owner/repo" format (e.g. octocat/Hello-World)'
    ),
});

export async function addRepoByName(formData: FormData) {
  const parsed = addSchema.parse({
    projectId: formData.get("projectId"),
    fullName: formData.get("fullName"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.repo.findUnique({
    where: {
      projectId_fullName: {
        projectId: parsed.projectId,
        fullName: parsed.fullName,
      },
    },
  });
  if (existing) {
    if (!existing.active) {
      await prisma.repo.update({
        where: { id: existing.id },
        data: { active: true },
      });
    }
  } else {
    await prisma.repo.create({
      data: {
        projectId: parsed.projectId,
        fullName: parsed.fullName,
        active: true,
      },
    });
    await recordAudit({
      projectId: parsed.projectId,
      actorId: session.user.id,
      kind: "repo.linked",
      payload: { fullName: parsed.fullName, manual: true },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/repos`);
}

const removeSchema = z.object({
  projectId: z.string().min(1),
  repoId: z.string().min(1),
});

export async function removeRepo(formData: FormData) {
  const parsed = removeSchema.parse({
    projectId: formData.get("projectId"),
    repoId: formData.get("repoId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.repo.findUnique({
    where: { id: parsed.repoId },
  });
  if (!existing || existing.projectId !== parsed.projectId) {
    throw new Error("Repo not found");
  }

  await prisma.repo.delete({ where: { id: existing.id } });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "repo.unlinked",
    payload: { fullName: existing.fullName, ghRepoId: existing.ghRepoId },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/repos`);
}
