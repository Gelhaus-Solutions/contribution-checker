"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { assertLabelsUnique } from "@/lib/labels";
import { slugSchema } from "@/lib/slug";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import { reGateProjectPrs } from "@/lib/temporal/start";
import { ALL_AI_TASKS } from "@/lib/ai/registry";
import { serializeAiConfig } from "@/lib/ai/config";
import { ALL_GUARD_RULE_IDS, serializeGuardRules } from "@/lib/guard/rules";
import {
  parseGuardApproversInput,
  parseGuardGlobsInput,
  serializeGuardApprovers,
  serializeGuardGlobs,
} from "@/lib/guard/config";
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
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  // Checked against every label the bot owns, not just these four: the staging,
  // QA and guard labels are edited on other forms, and two forms converging on
  // one name is exactly the collision that silently breaks one of them.
  await assertLabelsUnique(parsed.projectId, {
    labelPending: parsed.labelPending,
    labelApproved: parsed.labelApproved,
    labelDenied: parsed.labelDenied,
    labelEvaluate: parsed.labelEvaluate,
  });

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

const aiSchema = z.object({
  projectId: z.string().min(1),
  aiEnabled: z.string().optional(),
  aiAutoRun: z.string().optional(),
});

/**
 * AI settings.
 *
 * Task toggles are read from the catalog rather than from a fixed list, exactly
 * as `updateQualityHeuristics` reads `ALL_HEURISTICS`, so adding a task to
 * `ALL_AI_TASKS` makes its checkbox work here with no change to this function.
 *
 * The config is written through `serializeAiConfig` rather than `JSON.stringify`
 * so key order is stable: the audit payload below diffs before against after,
 * and an unstable order would make every save look like a change.
 */
export async function updateAiSettings(formData: FormData) {
  const parsed = aiSchema.parse({
    projectId: formData.get("projectId"),
    aiEnabled: formData.get("aiEnabled") ?? undefined,
    aiAutoRun: formData.get("aiAutoRun") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: { aiEnabled: true, aiAutoRun: true, aiConfig: true },
  });
  if (!before) throw new Error("Project not found");

  const config: Record<string, { enabled: boolean }> = {};
  for (const task of ALL_AI_TASKS) {
    config[task.id] = { enabled: formData.get(`enabled.${task.id}`) === "1" };
  }

  const after = {
    aiEnabled: !!parsed.aiEnabled,
    aiAutoRun: !!parsed.aiAutoRun,
    aiConfig: serializeAiConfig(config),
  };

  await prisma.project.update({ where: { id: parsed.projectId }, data: after });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "ai.settings_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          aiEnabled: [before.aiEnabled, after.aiEnabled],
          aiAutoRun: [before.aiAutoRun, after.aiAutoRun],
          aiConfig: [before.aiConfig, after.aiConfig],
        }).filter(([, [a, b]]) => a !== b)
      ),
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}

/** The `contribution:` namespace belongs to the gate: setLabels strips every
 * label in it that the gate did not just set, so a guard label placed there
 * would survive exactly until the next converge. Same rule the staging labels
 * are held to on the Staging page. */
const guardLabel = z
  .string()
  .min(1)
  .max(50)
  .refine(
    (v) => !v.startsWith("contribution:"),
    "guard labels cannot use the contribution: prefix, which the gate owns",
  );

/** Rule ids come from a checkbox group, so the browser sends only the checked
 * ones and an all-off form sends nothing at all. Unknown ids are rejected
 * rather than dropped: they can only come from a hand-edited form. */
const guardRule = z.enum(
  ALL_GUARD_RULE_IDS as [string, ...string[]],
);

const guardSchema = z.object({
  projectId: z.string().min(1),
  guardEnabled: z.string().optional(),
  guardRules: z.array(guardRule),
  guardGlobs: z.string().max(8000),
  guardApprovers: z.string().max(8000),
  guardUnlockMode: z.enum(["either", "both"]),
  labelGuardUnlock: guardLabel,
  labelGuardBlocked: guardLabel,
});

export async function updateGuardSettings(formData: FormData) {
  const parsed = guardSchema.parse({
    projectId: formData.get("projectId"),
    guardEnabled: formData.get("guardEnabled") ?? undefined,
    guardRules: formData.getAll("guardRules"),
    guardGlobs: formData.get("guardGlobs") ?? "",
    guardApprovers: formData.get("guardApprovers") ?? "",
    guardUnlockMode: formData.get("guardUnlockMode") ?? "either",
    labelGuardUnlock: formData.get("labelGuardUnlock"),
    labelGuardBlocked: formData.get("labelGuardBlocked"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  await assertLabelsUnique(parsed.projectId, {
    labelGuardUnlock: parsed.labelGuardUnlock,
    labelGuardBlocked: parsed.labelGuardBlocked,
  });

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      guardEnabled: true,
      guardRules: true,
      guardGlobs: true,
      guardApprovers: true,
      guardUnlockMode: true,
      labelGuardUnlock: true,
      labelGuardBlocked: true,
    },
  });
  if (!before) throw new Error("Project not found");

  // Everything normalized through its serializer so a value written here reads
  // back identically, which is what keeps a no-op save from looking like a
  // change in the audit log.
  const after = {
    guardEnabled: !!parsed.guardEnabled,
    guardRules: serializeGuardRules(parsed.guardRules),
    guardGlobs: serializeGuardGlobs(parseGuardGlobsInput(parsed.guardGlobs)),
    guardApprovers: serializeGuardApprovers(
      parseGuardApproversInput(parsed.guardApprovers),
    ),
    guardUnlockMode: parsed.guardUnlockMode,
    labelGuardUnlock: parsed.labelGuardUnlock,
    labelGuardBlocked: parsed.labelGuardBlocked,
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "guard.settings_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          guardEnabled: [before.guardEnabled, after.guardEnabled],
          guardRules: [before.guardRules, after.guardRules],
          guardGlobs: [before.guardGlobs, after.guardGlobs],
          guardApprovers: [before.guardApprovers, after.guardApprovers],
          guardUnlockMode: [before.guardUnlockMode, after.guardUnlockMode],
          labelGuardUnlock: [before.labelGuardUnlock, after.labelGuardUnlock],
          labelGuardBlocked: [
            before.labelGuardBlocked,
            after.labelGuardBlocked,
          ],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  // A newly guarded path has to take effect on PRs that are already open, not
  // only on the next one somebody pushes to. Same reason a bypass change
  // re-gates: the setting describes the PRs, not the events.
  await reGateProjectPrs({
    projectId: parsed.projectId,
    reason: "guard_settings_changed",
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings`);
}
