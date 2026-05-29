"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { slugSchema } from "@/lib/slug";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/http/safe-url";

const settingsSchema = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .min(2)
    .max(80)
    .refine((v) => !/[\r\n]/.test(v), "name cannot contain line breaks"),
  slug: slugSchema,
  description: z.string().max(500).optional(),
  cooldownDays: z
    .union([z.string().length(0), z.coerce.number().int().min(0).max(3650)])
    .optional(),
  requireApprovalCount: z
    .union([z.string().length(0), z.coerce.number().int().min(0).max(10)])
    .optional(),
});

export async function updateProjectSettings(formData: FormData) {
  const parsed = settingsSchema.parse({
    projectId: formData.get("projectId"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: String(formData.get("description") ?? "").trim() || undefined,
    cooldownDays: formData.get("cooldownDays") ?? undefined,
    requireApprovalCount: formData.get("requireApprovalCount") ?? undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      name: true,
      slug: true,
      description: true,
      cooldownDays: true,
      requireApprovalCount: true,
    },
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
  const requireApprovalCount =
    typeof parsed.requireApprovalCount === "number"
      ? parsed.requireApprovalCount
      : 0;

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
      cooldownDays: cooldown,
      requireApprovalCount,
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
          requireApprovalCount: [
            before.requireApprovalCount,
            requireApprovalCount,
          ],
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
  labelEvaluate: z.string().min(1).max(50),
});

export async function updateLabelSettings(formData: FormData) {
  const parsed = labelsSchema.parse({
    projectId: formData.get("projectId"),
    labelsEnabled: formData.get("labelsEnabled") ?? undefined,
    labelPending: formData.get("labelPending"),
    labelApproved: formData.get("labelApproved"),
    labelDenied: formData.get("labelDenied"),
    labelEvaluate: formData.get("labelEvaluate"),
  });
  const labelSet = new Set([
    parsed.labelPending,
    parsed.labelApproved,
    parsed.labelDenied,
    parsed.labelEvaluate,
  ]);
  if (labelSet.size !== 4) {
    throw new Error("All four labels must be unique.");
  }
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      labelsEnabled: !!parsed.labelsEnabled,
      labelPending: parsed.labelPending,
      labelApproved: parsed.labelApproved,
      labelDenied: parsed.labelDenied,
      labelEvaluate: parsed.labelEvaluate,
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

const webhookKindSchema = z.enum(["generic", "discord"]);

const addWebhookSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().max(80).optional(),
  kind: webhookKindSchema,
  url: z.string().url().max(2000),
  secret: z
    .union([z.literal(""), z.string().min(8).max(120)])
    .transform((v) => (v ? v : null)),
});

export async function addProjectWebhook(formData: FormData) {
  const parsed = addWebhookSchema.parse({
    projectId: formData.get("projectId"),
    name: String(formData.get("name") ?? "").trim() || undefined,
    kind: formData.get("kind"),
    url: String(formData.get("url") ?? "").trim(),
    secret: String(formData.get("secret") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  try {
    await assertSafeOutboundUrl(parsed.url);
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) throw new Error(e.message);
    throw e;
  }

  await prisma.projectWebhook.create({
    data: {
      projectId: parsed.projectId,
      name: parsed.name ?? null,
      kind: parsed.kind,
      url: parsed.url,
      // Secret is meaningless for Discord — drop it.
      secret: parsed.kind === "discord" ? null : parsed.secret,
      enabled: true,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "webhook", action: "added", kind: parsed.kind },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const updateWebhookSchema = z.object({
  projectId: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string().max(80).optional(),
  kind: webhookKindSchema,
  url: z.string().url().max(2000),
  secret: z
    .union([z.literal(""), z.string().min(8).max(120)])
    .transform((v) => (v ? v : null)),
  enabled: z.string().optional(),
});

export async function updateProjectWebhook(formData: FormData) {
  const parsed = updateWebhookSchema.parse({
    projectId: formData.get("projectId"),
    endpointId: formData.get("endpointId"),
    name: String(formData.get("name") ?? "").trim() || undefined,
    kind: formData.get("kind"),
    url: String(formData.get("url") ?? "").trim(),
    secret: String(formData.get("secret") ?? "").trim(),
    enabled: formData.get("enabled") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.projectWebhook.findUnique({
    where: { id: parsed.endpointId },
    select: { projectId: true },
  });
  if (!existing || existing.projectId !== parsed.projectId) {
    throw new Error("Webhook endpoint not found");
  }

  try {
    await assertSafeOutboundUrl(parsed.url);
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) throw new Error(e.message);
    throw e;
  }

  await prisma.projectWebhook.update({
    where: { id: parsed.endpointId },
    data: {
      name: parsed.name ?? null,
      kind: parsed.kind,
      url: parsed.url,
      secret: parsed.kind === "discord" ? null : parsed.secret,
      enabled: !!parsed.enabled,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "webhook", action: "updated", kind: parsed.kind },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const deleteWebhookSchema = z.object({
  projectId: z.string().min(1),
  endpointId: z.string().min(1),
});

export async function deleteProjectWebhook(formData: FormData) {
  const parsed = deleteWebhookSchema.parse({
    projectId: formData.get("projectId"),
    endpointId: formData.get("endpointId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.projectWebhook.findUnique({
    where: { id: parsed.endpointId },
    select: { projectId: true },
  });
  if (!existing || existing.projectId !== parsed.projectId) {
    throw new Error("Webhook endpoint not found");
  }

  await prisma.projectWebhook.delete({ where: { id: parsed.endpointId } });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: { section: "webhook", action: "deleted" },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const gatingSchema = z.object({
  projectId: z.string().min(1),
  checkerEnabled: z.string().optional(),
  applicationRequired: z.string().optional(),
  trackWhenDisabled: z.string().optional(),
  checksEnabled: z.string().optional(),
});

export async function updateGatingSettings(formData: FormData) {
  const parsed = gatingSchema.parse({
    projectId: formData.get("projectId"),
    checkerEnabled: formData.get("checkerEnabled") ?? undefined,
    applicationRequired: formData.get("applicationRequired") ?? undefined,
    trackWhenDisabled: formData.get("trackWhenDisabled") ?? undefined,
    checksEnabled: formData.get("checksEnabled") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      checkerEnabled: true,
      applicationRequired: true,
      trackWhenDisabled: true,
      checksEnabled: true,
    },
  });
  if (!before) throw new Error("Project not found");

  const after = {
    checkerEnabled: !!parsed.checkerEnabled,
    applicationRequired: !!parsed.applicationRequired,
    trackWhenDisabled: !!parsed.trackWhenDisabled,
    checksEnabled: !!parsed.checksEnabled,
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.gating_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          checkerEnabled: [before.checkerEnabled, after.checkerEnabled],
          applicationRequired: [
            before.applicationRequired,
            after.applicationRequired,
          ],
          trackWhenDisabled: [before.trackWhenDisabled, after.trackWhenDisabled],
          checksEnabled: [before.checksEnabled, after.checksEnabled],
        }).filter(([, [a, b]]) => a !== b)
      ),
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const testSchema = z.object({
  projectId: z.string().min(1),
  endpointId: z.string().min(1).optional(),
});

export async function sendTestWebhook(formData: FormData) {
  const parsed = testSchema.parse({
    projectId: formData.get("projectId"),
    endpointId: String(formData.get("endpointId") ?? "") || undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  if (parsed.endpointId) {
    const ep = await prisma.projectWebhook.findUnique({
      where: { id: parsed.endpointId },
      select: { projectId: true },
    });
    if (!ep || ep.projectId !== parsed.projectId) {
      throw new Error("Webhook endpoint not found");
    }
  }

  await enqueueProjectWebhook({
    projectId: parsed.projectId,
    event: "application.submitted",
    payload: { test: true, sentBy: session.user.ghLogin },
    triggeredById: session.user.id,
    endpointId: parsed.endpointId ?? null,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "webhook.test_sent",
    payload: parsed.endpointId ? { endpointId: parsed.endpointId } : undefined,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}
