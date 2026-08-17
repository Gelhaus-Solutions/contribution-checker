"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { slugSchema } from "@/lib/slug";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import { reGateProjectPrs, signalStagingBatch } from "@/lib/temporal/start";
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
  allowAppeals: z.string().optional(),
});

export async function updateProjectSettings(formData: FormData) {
  const parsed = settingsSchema.parse({
    projectId: formData.get("projectId"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: String(formData.get("description") ?? "").trim() || undefined,
    cooldownDays: formData.get("cooldownDays") ?? undefined,
    requireApprovalCount: formData.get("requireApprovalCount") ?? undefined,
    allowAppeals: formData.get("allowAppeals") ?? undefined,
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
      allowAppeals: true,
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
  const allowAppeals = !!parsed.allowAppeals;

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
      cooldownDays: cooldown,
      requireApprovalCount,
      allowAppeals,
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
          allowAppeals: [before.allowAppeals, allowAppeals],
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

  // Bypass handles/collaborators are decideForRepo inputs: auto-re-gate the
  // project's open PRs so the change takes effect without a manual re-evaluate.
  await reGateProjectPrs({
    projectId: parsed.projectId,
    reason: "bypass_settings_changed",
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
  // The `contribution:` namespace belongs to the gate: setLabels strips every
  // label in it that the gate did not just set, so a staging label placed
  // there would survive exactly until the next converge.
  labelStagingBatch: z
    .string()
    .min(1)
    .max(50)
    .refine(
      (v) => !v.startsWith("contribution:"),
      "staging labels cannot use the contribution: prefix, which the gate owns",
    ),
  labelStagingOptOut: z
    .string()
    .min(1)
    .max(50)
    .refine(
      (v) => !v.startsWith("contribution:"),
      "staging labels cannot use the contribution: prefix, which the gate owns",
    ),
});

export async function updateLabelSettings(formData: FormData) {
  const parsed = labelsSchema.parse({
    projectId: formData.get("projectId"),
    labelsEnabled: formData.get("labelsEnabled") ?? undefined,
    labelPending: formData.get("labelPending"),
    labelApproved: formData.get("labelApproved"),
    labelDenied: formData.get("labelDenied"),
    labelEvaluate: formData.get("labelEvaluate"),
    labelStagingBatch: formData.get("labelStagingBatch"),
    labelStagingOptOut: formData.get("labelStagingOptOut"),
  });
  const labelSet = new Set([
    parsed.labelPending,
    parsed.labelApproved,
    parsed.labelDenied,
    parsed.labelEvaluate,
    parsed.labelStagingBatch,
    parsed.labelStagingOptOut,
  ]);
  if (labelSet.size !== 6) {
    throw new Error("All six labels must be unique.");
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
      labelStagingBatch: parsed.labelStagingBatch,
      labelStagingOptOut: parsed.labelStagingOptOut,
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
      // Secret is meaningless for Discord, so drop it.
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

  // checkerEnabled / applicationRequired are decideForRepo inputs and
  // checksEnabled changes check publishing: auto-re-gate the project's open PRs
  // when any of them changed so the toggle takes effect immediately.
  const gateAffecting =
    before.checkerEnabled !== after.checkerEnabled ||
    before.applicationRequired !== after.applicationRequired ||
    before.checksEnabled !== after.checksEnabled;
  if (gateAffecting) {
    await reGateProjectPrs({
      projectId: parsed.projectId,
      reason: "gating_settings_changed",
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

const stagingSchema = z.object({
  projectId: z.string().min(1),
  stagingRetargetEnabled: z.string().optional(),
  stagingBatchPrEnabled: z.string().optional(),
  // Git allows almost anything in a branch name; reject only the characters
  // git itself forbids plus whitespace, so a typo fails here and not on the
  // first API call.
  stagingBranch: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (v) => !/[\s~^:?*[\\]/.test(v) && !v.includes(".."),
      "not a valid branch name",
    ),
});

export async function updateStagingSettings(formData: FormData) {
  const parsed = stagingSchema.parse({
    projectId: formData.get("projectId"),
    stagingRetargetEnabled:
      formData.get("stagingRetargetEnabled") ?? undefined,
    stagingBatchPrEnabled: formData.get("stagingBatchPrEnabled") ?? undefined,
    stagingBranch: formData.get("stagingBranch"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingBranch: true,
    },
  });
  if (!before) throw new Error("Project not found");

  const after = {
    stagingRetargetEnabled: !!parsed.stagingRetargetEnabled,
    stagingBatchPrEnabled: !!parsed.stagingBatchPrEnabled,
    stagingBranch: parsed.stagingBranch,
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.staging_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          stagingRetargetEnabled: [
            before.stagingRetargetEnabled,
            after.stagingRetargetEnabled,
          ],
          stagingBatchPrEnabled: [
            before.stagingBatchPrEnabled,
            after.stagingBatchPrEnabled,
          ],
          stagingBranch: [before.stagingBranch, after.stagingBranch],
        }).filter(([, [a, b]]) => a !== b)
      ),
    },
  });

  // Retargeting is decided per PR event, so switching it on (or moving the
  // branch) only reaches existing PRs via a re-gate. This covers PRs with a
  // PrCheck row; untracked ones retarget on their next event.
  const retargetAffecting =
    before.stagingRetargetEnabled !== after.stagingRetargetEnabled ||
    before.stagingBranch !== after.stagingBranch;
  if (retargetAffecting && after.stagingRetargetEnabled) {
    await reGateProjectPrs({
      projectId: parsed.projectId,
      reason: "staging_settings_changed",
    });
  }

  // The aggregate PR is only re-derived when something signals its entity, so
  // nudge every App-installed repo once after the toggle flips on.
  const batchAffecting =
    before.stagingBatchPrEnabled !== after.stagingBatchPrEnabled ||
    before.stagingBranch !== after.stagingBranch;
  if (batchAffecting && after.stagingBatchPrEnabled) {
    const repos = await prisma.repo.findMany({
      where: {
        projectId: parsed.projectId,
        active: true,
        installationId: { not: null },
      },
      select: { id: true },
    });
    for (const repo of repos) {
      await signalStagingBatch({
        repoId: repo.id,
        reason: "staging_settings_changed",
      });
    }
  }

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
