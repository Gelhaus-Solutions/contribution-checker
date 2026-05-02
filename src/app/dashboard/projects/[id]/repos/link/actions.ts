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
    select: { id: true, ghRepoId: true, fullName: true, installationId: true },
  });
  const byGhId = new Map(
    existing.filter((r) => r.ghRepoId != null).map((r) => [r.ghRepoId!, r])
  );
  const byFullName = new Map(existing.map((r) => [r.fullName, r]));

  const desiredIds = new Set(selections.map((s) => s.ghRepoId));
  // Only remove repos that were previously linked through this installation
  // and are no longer selected. Manually-added rows (installationId: null)
  // are preserved.
  const toRemove = existing.filter(
    (r) =>
      r.installationId === parsed.installationId &&
      r.ghRepoId != null &&
      !desiredIds.has(r.ghRepoId)
  );

  for (const sel of selections) {
    const found = byGhId.get(sel.ghRepoId) ?? byFullName.get(sel.fullName);
    if (found) {
      await prisma.repo.update({
        where: { id: found.id },
        data: {
          fullName: sel.fullName,
          ghRepoId: sel.ghRepoId,
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
    await prisma.repo.update({
      where: { id: r.id },
      data: { installationId: null, ghRepoId: null },
    });
    await recordAudit({
      projectId: parsed.projectId,
      actorId: session.user.id,
      kind: "repo.unlinked",
      payload: { ghRepoId: r.ghRepoId, fullName: r.fullName },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/repos`);
  redirect(`/dashboard/projects/${parsed.projectId}/repos`);
}
