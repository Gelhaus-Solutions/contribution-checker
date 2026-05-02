"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { onApplicationApproved } from "@/lib/github/post-decision";

const ghLoginPattern = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

const addSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: z
    .string()
    .min(1)
    .max(80)
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => ghLoginPattern.test(s), "Not a valid GitHub login"),
  status: z.enum(["APPROVED", "DENIED"]),
  reason: z
    .string()
    .max(500)
    .optional()
    .transform((s) => (s && s.trim().length > 0 ? s.trim() : undefined)),
});

export async function addManualDecision(formData: FormData) {
  const parsed = addSchema.parse({
    projectId: formData.get("projectId"),
    ghLogin: formData.get("ghLogin"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  // If the GitHub user happens to already be in our DB, capture their numeric id.
  const existingUser = await prisma.user.findUnique({
    where: { ghLogin: parsed.ghLogin },
    select: { id: true, ghId: true },
  });

  await prisma.manualDecision.upsert({
    where: {
      projectId_ghLogin: {
        projectId: parsed.projectId,
        ghLogin: parsed.ghLogin,
      },
    },
    update: {
      status: parsed.status,
      reason: parsed.reason ?? null,
      decidedById: session.user.id,
      ghId: existingUser?.ghId ?? null,
    },
    create: {
      projectId: parsed.projectId,
      ghLogin: parsed.ghLogin,
      ghId: existingUser?.ghId ?? null,
      status: parsed.status,
      reason: parsed.reason ?? null,
      decidedById: session.user.id,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: parsed.status === "APPROVED" ? "application.approved" : "application.denied",
    payload: {
      manual: true,
      ghLogin: parsed.ghLogin,
      reason: parsed.reason ?? null,
    },
  });

  // If we just approved someone with an existing application that's pending
  // closed PRs, reopen them. This piggy-backs on the existing approval-side
  // effects by approving any SUBMITTED Application from this user.
  if (parsed.status === "APPROVED" && existingUser) {
    const pendingApp = await prisma.application.findFirst({
      where: {
        projectId: parsed.projectId,
        userId: existingUser.id,
        status: "SUBMITTED",
      },
    });
    if (pendingApp) {
      await prisma.application.update({
        where: { id: pendingApp.id },
        data: {
          status: "APPROVED",
          decidedById: session.user.id,
          decidedAt: new Date(),
          reason: parsed.reason,
        },
      });
      await onApplicationApproved({ applicationId: pendingApp.id });
    }
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/decisions`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}`);
}

const removeSchema = z.object({
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
});

export async function removeManualDecision(formData: FormData) {
  const parsed = removeSchema.parse({
    projectId: formData.get("projectId"),
    decisionId: formData.get("decisionId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.manualDecision.findUnique({
    where: { id: parsed.decisionId },
  });
  if (!existing || existing.projectId !== parsed.projectId) {
    throw new Error("Decision not found");
  }

  await prisma.manualDecision.delete({ where: { id: parsed.decisionId } });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.updated",
    payload: {
      manualDecisionRemoved: {
        ghLogin: existing.ghLogin,
        status: existing.status,
      },
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/decisions`);
}
