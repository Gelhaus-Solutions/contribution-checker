"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { ALL_HEURISTICS } from "@/lib/quality/registry";
import { runQualityForPrCheck } from "@/lib/quality/run";
import { logger } from "@/lib/logger";

const enabledSchema = z.object({
  projectId: z.string().min(1),
  qualityEnabled: z.string().optional(),
  qualityCommentMin: z.coerce.number().int().min(0).max(100),
  prTemplateHoneypots: z.string().max(8000).optional(),
});

export async function updateQualityCore(formData: FormData) {
  const parsed = enabledSchema.parse({
    projectId: formData.get("projectId"),
    qualityEnabled: formData.get("qualityEnabled") ?? undefined,
    qualityCommentMin: formData.get("qualityCommentMin"),
    prTemplateHoneypots: formData.get("prTemplateHoneypots") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const honeypots = (parsed.prTemplateHoneypots ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 50);

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      qualityEnabled: !!parsed.qualityEnabled,
      qualityCommentMin: parsed.qualityCommentMin,
      prTemplateHoneypots: JSON.stringify(honeypots),
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.quality_changed",
    payload: { section: "core", honeypotCount: honeypots.length },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/quality`);
}

const heuristicsSchema = z.object({ projectId: z.string().min(1) });

export async function updateQualityHeuristics(formData: FormData) {
  const projectId = heuristicsSchema.parse({
    projectId: formData.get("projectId"),
  }).projectId;
  const { session } = await requireProjectRole(projectId, "ADMIN");

  const config: Record<string, { enabled: boolean; threshold?: unknown }> = {};
  for (const h of ALL_HEURISTICS) {
    const enabled = formData.get(`enabled.${h.id}`) === "1";
    const setting: { enabled: boolean; threshold?: unknown } = { enabled };
    if (h.thresholdKind === "number") {
      const raw = formData.get(`threshold.${h.id}`);
      if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) setting.threshold = n;
      }
    } else if (h.thresholdKind === "stringList") {
      const raw = formData.get(`threshold.${h.id}`);
      if (typeof raw === "string") {
        const items = raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length > 0) setting.threshold = items;
      }
    }
    config[h.id] = setting;
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { qualityConfig: JSON.stringify(config) },
  });

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "settings.quality_changed",
    payload: {
      section: "heuristics",
      enabledCount: Object.values(config).filter((s) => s.enabled).length,
    },
  });

  revalidatePath(`/dashboard/projects/${projectId}/quality`);
}

const backfillSchema = z.object({ projectId: z.string().min(1) });

/**
 * Re-score every PrCheck row in the project. Synchronous-ish: runs in a
 * background-ish loop with concurrency 1 so we don't slam the GitHub API.
 * Caps at 200 PrChecks per run to stay under reasonable request budgets.
 */
export async function backfillQuality(formData: FormData) {
  const { projectId } = backfillSchema.parse({
    projectId: formData.get("projectId"),
  });
  const { session } = await requireProjectRole(projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      qualityEnabled: true,
      qualityConfig: true,
      qualityCommentMin: true,
      prTemplateHoneypots: true,
      checkerEnabled: true,
      trackWhenDisabled: true,
    },
  });
  if (!project) throw new Error("Project not found");
  if (!project.qualityEnabled) {
    throw new Error("Enable PR Quality scoring before backfilling.");
  }

  const checks = await prisma.prCheck.findMany({
    where: { repo: { projectId } },
    select: {
      id: true,
      prNumber: true,
      repo: {
        select: { fullName: true, installationId: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "quality.backfill_started",
    payload: { count: checks.length },
  });

  let scored = 0;
  for (const c of checks) {
    if (!c.repo.installationId) continue;
    try {
      const res = await runQualityForPrCheck({
        prCheckId: c.id,
        installationId: c.repo.installationId,
        repoFullName: c.repo.fullName,
        prNumber: c.prNumber,
        project,
        skipComment: true,
      });
      if (res) scored += 1;
    } catch (e) {
      logger.warn({ err: e, prCheckId: c.id }, "backfill: scoring failed");
    }
  }

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "quality.backfill_completed",
    payload: { scored, total: checks.length },
  });

  revalidatePath(`/dashboard/projects/${projectId}/quality`);
}
