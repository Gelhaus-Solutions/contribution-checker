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

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
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

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
}

import { computeScore } from "@/lib/quality/score";
import { parseQualityConfig } from "@/lib/quality/registry";
import type { SignalsRaw } from "@/lib/quality/types";

export type UserOverview = {
  ghLogin: string;
  application: {
    id: string;
    status: string;
    createdAt: string;
    decidedAt: string | null;
    reason: string | null;
    answersPreview: string;
  } | null;
  manualDecision: {
    id: string;
    status: string;
    reason: string | null;
    decidedAt: string;
  } | null;
  prStats: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
    bypassed: number;
    closedByApp: number;
  };
  averageQuality: number | null;
  scoredPrCount: number;
  qualityEnabled: boolean;
};

const overviewSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: z.string().min(1).max(80),
});

/**
 * Fetch everything the People-row dialog needs: original application,
 * manual decision (if any), PR list with computed quality scores.
 *
 * Quality score is computed on the fly using the project's *current* config
 * — flipping a heuristic toggle is reflected immediately without a recompute.
 */
export async function getUserOverview(args: {
  projectId: string;
  ghLogin: string;
}): Promise<UserOverview> {
  const { projectId, ghLogin } = overviewSchema.parse(args);
  await requireProjectRole(projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { qualityEnabled: true, qualityConfig: true },
  });
  if (!project) throw new Error("Project not found");

  const config = parseQualityConfig(project.qualityConfig);

  const [user, manual] = await Promise.all([
    prisma.user.findUnique({
      where: { ghLogin },
      select: {
        id: true,
        applications: {
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.manualDecision.findUnique({
      where: { projectId_ghLogin: { projectId, ghLogin: ghLogin.toLowerCase() } },
    }),
  ]);

  const application = user?.applications[0]
    ? {
        id: user.applications[0].id,
        status: user.applications[0].status,
        createdAt: user.applications[0].createdAt.toISOString(),
        decidedAt: user.applications[0].decidedAt?.toISOString() ?? null,
        reason: user.applications[0].reason,
        answersPreview: user.applications[0].answers.slice(0, 800),
      }
    : null;

  const prChecks = await prisma.prCheck.findMany({
    where: {
      authorGhLogin: ghLogin,
      repo: { projectId },
    },
    include: {
      quality: project.qualityEnabled,
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const stats = {
    total: prChecks.length,
    pending: 0,
    approved: 0,
    denied: 0,
    bypassed: 0,
    closedByApp: 0,
  };
  const scoresForAverage: number[] = [];

  for (const c of prChecks) {
    if (c.status === "PENDING") stats.pending += 1;
    if (c.status === "APPROVED") stats.approved += 1;
    if (c.status === "DENIED") stats.denied += 1;
    if (c.status === "BYPASSED") stats.bypassed += 1;
    if (c.closedByApp) stats.closedByApp += 1;

    if (project.qualityEnabled && c.quality) {
      const signals = JSON.parse(c.quality.signalsRaw) as SignalsRaw;
      const summary = computeScore(signals, config);
      if (summary.score !== null) scoresForAverage.push(summary.score);
    }
  }

  const averageQuality =
    scoresForAverage.length > 0
      ? Math.round(
          scoresForAverage.reduce((a, b) => a + b, 0) / scoresForAverage.length
        )
      : null;

  return {
    ghLogin,
    application,
    manualDecision: manual
      ? {
          id: manual.id,
          status: manual.status,
          reason: manual.reason,
          decidedAt: manual.updatedAt.toISOString(),
        }
      : null,
    prStats: stats,
    averageQuality,
    scoredPrCount: scoresForAverage.length,
    qualityEnabled: project.qualityEnabled,
  };
}
