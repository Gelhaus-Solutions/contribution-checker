"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { getAppSlug, getInstallationOctokit } from "@/lib/github/app";
import { projectTenant } from "@/lib/github/gmint-tokens";

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

const relinkSchema = z.object({
  projectId: z.string().min(1),
  repoId: z.string().min(1),
});

/**
 * The repo as the installation lists it, or null when the installation no
 * longer has it (the App was uninstalled, or the repo taken off it).
 */
async function findOnInstallation(args: {
  installationId: number;
  fullName: string;
  projectId: string;
}): Promise<{ id: number } | null> {
  try {
    const octokit = await getInstallationOctokit(
      args.installationId,
      { purpose: "repo-link", permissions: {} },
      projectTenant(args.projectId),
    );
    const want = args.fullName.toLowerCase();
    for (let page = 1; ; page++) {
      const { data } = await octokit.request("GET /installation/repositories", {
        per_page: 100,
        page,
      });
      const hit = data.repositories.find((r) => r.full_name.toLowerCase() === want);
      if (hit) return { id: Number(hit.id) };
      if (data.repositories.length < 100) return null;
    }
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/**
 * Link a detached repo again, keeping its row: its staging settings, tracked
 * release PR, PR checks and staging batches. Removing it and adding it back
 * deletes all of those (postiz-app, 2026-11-15). When the installation it was
 * detached from no longer has it, the App's installation page on GitHub is
 * where it goes back, and the installation event links the row by itself.
 */
export async function relinkRepo(formData: FormData) {
  const parsed = relinkSchema.parse({
    projectId: formData.get("projectId"),
    repoId: formData.get("repoId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const repo = await prisma.repo.findUnique({ where: { id: parsed.repoId } });
  if (!repo || repo.projectId !== parsed.projectId) {
    throw new Error("Repo not found");
  }
  const installationId = repo.detachedFromInstallationId;
  if (repo.installationId == null && installationId != null) {
    const found = await findOnInstallation({
      installationId,
      fullName: repo.fullName,
      projectId: parsed.projectId,
    });
    if (!found) {
      redirect(
        `https://github.com/apps/${await getAppSlug()}/installations/new?state=${encodeURIComponent(parsed.projectId)}`,
      );
    }
    await prisma.repo.update({
      where: { id: repo.id },
      data: {
        installationId,
        ghRepoId: found.id,
        active: true,
        detachedFromInstallationId: null,
      },
    });
    await recordAudit({
      projectId: parsed.projectId,
      actorId: session.user.id,
      kind: "repo.relinked",
      payload: { fullName: repo.fullName, ghRepoId: found.id, installationId },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/repos`);
}
