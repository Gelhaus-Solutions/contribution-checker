"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { slugSchema } from "@/lib/slug";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";

const settingsSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(2).max(80),
  slug: slugSchema,
  description: z.string().max(500).optional(),
  cooldownDays: z
    .union([z.string().length(0), z.coerce.number().int().min(0).max(3650)])
    .optional(),
});

export async function updateProjectSettings(formData: FormData) {
  const parsed = settingsSchema.parse({
    projectId: formData.get("projectId"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: String(formData.get("description") ?? "").trim() || undefined,
    cooldownDays: formData.get("cooldownDays") ?? undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: { name: true, slug: true, description: true, cooldownDays: true },
  });
  if (!before) throw new Error("Project not found");

  if (parsed.slug !== before.slug) {
    const clash = await prisma.project.findUnique({
      where: { slug: parsed.slug },
      select: { id: true },
    });
    if (clash && clash.id !== parsed.projectId) {
      throw new Error(`Slug "${parsed.slug}" is already taken.`);
    }
  }

  const cooldown =
    typeof parsed.cooldownDays === "number" ? parsed.cooldownDays : null;

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
      cooldownDays: cooldown,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          name: [before.name, parsed.name],
          slug: [before.slug, parsed.slug],
          description: [before.description, parsed.description ?? null],
          cooldownDays: [before.cooldownDays, cooldown],
        }).filter(([, [a, b]]) => a !== b)
      ),
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const bypassSchema = z.object({
  projectId: z.string().min(1),
  bypassHandles: z.string().max(8000),
  bypassCollabs: z.string().optional(),
});

export async function updateBypassSettings(formData: FormData) {
  const parsed = bypassSchema.parse({
    projectId: formData.get("projectId"),
    bypassHandles: formData.get("bypassHandles") ?? "",
    bypassCollabs: formData.get("bypassCollabs") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const handles = parsed.bypassHandles
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => /^[a-z0-9*?\-\[\]]+$/i.test(s))
    .slice(0, 200);

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      bypassHandles: JSON.stringify(handles),
      bypassCollabs: !!parsed.bypassCollabs,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "bypass", count: handles.length, bypassCollabs: !!parsed.bypassCollabs },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const labelsSchema = z.object({
  projectId: z.string().min(1),
  labelsEnabled: z.string().optional(),
  labelPending: z.string().min(1).max(50),
  labelApproved: z.string().min(1).max(50),
  labelDenied: z.string().min(1).max(50),
});

export async function updateLabelSettings(formData: FormData) {
  const parsed = labelsSchema.parse({
    projectId: formData.get("projectId"),
    labelsEnabled: formData.get("labelsEnabled") ?? undefined,
    labelPending: formData.get("labelPending"),
    labelApproved: formData.get("labelApproved"),
    labelDenied: formData.get("labelDenied"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      labelsEnabled: !!parsed.labelsEnabled,
      labelPending: parsed.labelPending,
      labelApproved: parsed.labelApproved,
      labelDenied: parsed.labelDenied,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "labels" },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const webhookSchema = z.object({
  projectId: z.string().min(1),
  webhookUrl: z
    .union([z.literal(""), z.string().url()])
    .transform((v) => (v ? v : null)),
  webhookSecret: z
    .union([z.literal(""), z.string().min(8).max(120)])
    .transform((v) => (v ? v : null)),
});

export async function updateWebhookSettings(formData: FormData) {
  const parsed = webhookSchema.parse({
    projectId: formData.get("projectId"),
    webhookUrl: String(formData.get("webhookUrl") ?? "").trim(),
    webhookSecret: String(formData.get("webhookSecret") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      webhookUrl: parsed.webhookUrl,
      webhookSecret: parsed.webhookSecret,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "webhook", urlSet: !!parsed.webhookUrl },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const testSchema = z.object({ projectId: z.string().min(1) });

export async function sendTestWebhook(formData: FormData) {
  const parsed = testSchema.parse({ projectId: formData.get("projectId") });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  await enqueueProjectWebhook({
    projectId: parsed.projectId,
    event: "application.submitted",
    payload: { test: true, sentBy: session.user.ghLogin },
    triggeredById: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "webhook.test_sent",
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}
