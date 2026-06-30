"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { ALL_HEURISTICS } from "@/lib/quality/registry";
import { startQualityBackfill } from "@/lib/temporal/start";

const enabledSchema = z.object({
  projectId: z.string().min(1),
  qualityEnabled: z.string().optional(),
  qualityCommentMin: z.coerce.number().int().min(0).max(100),
  qualityTemplateMatchPct: z.coerce.number().int().min(0).max(100),
  prTemplateHoneypots: z.string().max(8000).optional(),
});

export async function updateQualityCore(formData: FormData) {
  const parsed = enabledSchema.parse({
    projectId: formData.get("projectId"),
    qualityEnabled: formData.get("qualityEnabled") ?? undefined,
    qualityCommentMin: formData.get("qualityCommentMin"),
    qualityTemplateMatchPct: formData.get("qualityTemplateMatchPct"),
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
      qualityTemplateMatchPct: parsed.qualityTemplateMatchPct,
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
 * Re-score the project's PrChecks. Now durable: starts a `qualityBackfill`
 * Temporal workflow that fans out one retried activity per PR (bounded
 * concurrency) instead of looping synchronously inside this request (which
 * timed out on large projects). The start/completed audit events are written by
 * the workflow. Caps at 200 PrChecks per run, as before.
 */
export async function backfillQuality(formData: FormData) {
  const { projectId } = backfillSchema.parse({
    projectId: formData.get("projectId"),
  });
  const { session } = await requireProjectRole(projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, qualityEnabled: true },
  });
  if (!project) throw new Error("Project not found");
  if (!project.qualityEnabled) {
    throw new Error("Enable PR Quality scoring before backfilling.");
  }

  await startQualityBackfill(
    { projectId, triggeredById: session.user.id, limit: 200 },
    randomUUID()
  );

  revalidatePath(`/dashboard/projects/${projectId}/quality`);
}
