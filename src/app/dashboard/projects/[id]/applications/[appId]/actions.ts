"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  approveApplication,
  denyApplication,
  revokeApplication,
} from "@/lib/applications/decide";
import {
  onApplicationApproved,
  onApplicationRevokedWithClose,
} from "@/lib/github/post-decision";
import { recordAudit } from "@/lib/audit";

const baseSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

async function ensureApplicationInProject(projectId: string, appId: string) {
  const app = await prisma.application.findUnique({
    where: { id: appId },
    select: { id: true, projectId: true, status: true, userId: true },
  });
  if (!app || app.projectId !== projectId) {
    throw new Error("Application not found");
  }
  return app;
}

export async function approveAction(formData: FormData) {
  const parsed = baseSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "SUBMITTED") {
    throw new Error(`Cannot approve an application with status ${app.status}.`);
  }

  await approveApplication({
    applicationId: parsed.appId,
    decidedById: session.user.id,
    reason: parsed.reason,
  });

  await onApplicationApproved({ applicationId: parsed.appId });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

export async function denyAction(formData: FormData) {
  const parsed = baseSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "SUBMITTED") {
    throw new Error(`Cannot deny an application with status ${app.status}.`);
  }

  await denyApplication({
    applicationId: parsed.appId,
    decidedById: session.user.id,
    reason: parsed.reason,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

const revokeSchema = baseSchema.extend({
  closeOpenPrs: z.string().optional(),
});

export async function revokeAction(formData: FormData) {
  const parsed = revokeSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
    closeOpenPrs: formData.get("closeOpenPrs") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "APPROVED") {
    throw new Error(`Cannot revoke an application with status ${app.status}.`);
  }

  await revokeApplication({
    applicationId: parsed.appId,
    decidedById: session.user.id,
    reason: parsed.reason,
  });

  if (parsed.closeOpenPrs) {
    await onApplicationRevokedWithClose({
      applicationId: parsed.appId,
      reason: parsed.reason,
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

const noteSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  body: z.string().min(1).max(2000),
});

export async function addNoteAction(formData: FormData) {
  const parsed = noteSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    body: String(formData.get("body") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  await prisma.applicationNote.create({
    data: {
      applicationId: parsed.appId,
      authorId: session.user.id,
      body: parsed.body,
    },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.note_added",
    payload: { applicationId: parsed.appId },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}
