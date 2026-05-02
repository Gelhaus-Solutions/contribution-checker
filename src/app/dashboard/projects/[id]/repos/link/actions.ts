"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

const inputSchema = z.object({
  projectId: z.string().min(1),
  installationId: z.coerce.number().int().positive(),
});

export async function linkRepos(formData: FormData) {
  const parsed = inputSchema.parse({
    projectId: formData.get("projectId"),
    installationId: formData.get("installationId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const selections = formData
    .getAll("ghRepoIds")
    .map((v) => String(v))
    .map((s) => {
      const [idPart, ...rest] = s.split("|");
      return {
        ghRepoId: Number(idPart),
        fullName: rest.join("|"),
      };
    })
    .filter((r) => Number.isFinite(r.ghRepoId) && r.fullName.length > 0);

  const existing = await prisma.repo.findMany({
    where: { projectId: parsed.projectId },
    select: { id: true, ghRepoId: true },
  });
  const existingByGhId = new Map(existing.map((r) => [r.ghRepoId, r]));

  const desiredIds = new Set(selections.map((s) => s.ghRepoId));
  const toRemove = existing.filter((r) => !desiredIds.has(r.ghRepoId));

  for (const sel of selections) {
    const found = existingByGhId.get(sel.ghRepoId);
    if (found) {
      await prisma.repo.update({
        where: { id: found.id },
        data: {
          fullName: sel.fullName,
          installationId: parsed.installationId,
          active: true,
        },
      });
    } else {
      await prisma.repo.create({
        data: {
          projectId: parsed.projectId,
          ghRepoId: sel.ghRepoId,
          fullName: sel.fullName,
          installationId: parsed.installationId,
          active: true,
        },
      });
      await recordAudit({
        projectId: parsed.projectId,
        actorId: session.user.id,
        kind: "repo.linked",
        payload: { fullName: sel.fullName, ghRepoId: sel.ghRepoId },
      });
    }
  }

  for (const r of toRemove) {
    await prisma.repo.delete({ where: { id: r.id } });
    await recordAudit({
      projectId: parsed.projectId,
      actorId: session.user.id,
      kind: "repo.unlinked",
      payload: { ghRepoId: r.ghRepoId },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/repos`);
  redirect(`/dashboard/projects/${parsed.projectId}/repos`);
}
