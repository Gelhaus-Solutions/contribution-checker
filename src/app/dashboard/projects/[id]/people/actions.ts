"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import {
  dispatchContributorDecision,
  reGateAuthorPrs,
} from "@/lib/temporal/start";
import {
  approveApplication,
  denyApplication,
  revokeApplication,
  ApprovalGateError,
  ClaGateError,
} from "@/lib/applications/decide";
import { getClaStatus } from "@/lib/cla/status";
import { grantWaiver as grantClaWaiver } from "@/lib/cla/mutations";

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
      await dispatchContributorDecision("approved", pendingApp.id);
    }
  }

  // A manual decision changes the gate outcome for any open PRs by this author
  // (a manual DENY closes them; a manual APPROVE bypasses): re-evaluate them.
  await reGateAuthorPrs({
    projectId: parsed.projectId,
    ghLogin: parsed.ghLogin,
    ghId: existingUser?.ghId ?? null,
    reason: "manual_decision_added",
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}`);
}

const setManualSchema = z.object({
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
  status: z.enum(["APPROVED", "DENIED"]),
});

export async function setManualDecisionStatus(args: {
  projectId: string;
  decisionId: string;
  status: "APPROVED" | "DENIED";
}) {
  const parsed = setManualSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existing = await prisma.manualDecision.findUnique({
    where: { id: parsed.decisionId },
  });
  if (!existing || existing.projectId !== parsed.projectId) {
    throw new Error("Decision not found");
  }
  if (existing.status === parsed.status) return;

  await prisma.manualDecision.update({
    where: { id: parsed.decisionId },
    data: { status: parsed.status, decidedById: session.user.id },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: parsed.status === "APPROVED" ? "application.approved" : "application.denied",
    payload: {
      manual: true,
      ghLogin: existing.ghLogin,
      from: existing.status,
    },
  });

  // Flipping a manual decision changes the gate outcome (decideForRepo reads it):
  // re-evaluate the author's open PRs. Previously a no-op gap.
  await reGateAuthorPrs({
    projectId: parsed.projectId,
    ghLogin: existing.ghLogin,
    ghId: existing.ghId,
    reason: "manual_decision_changed",
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
}

const removeSchema = z.object({
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
});

const setStatusSchema = z.object({
  projectId: z.string().min(1),
  applicationId: z.string().min(1),
  target: z.enum(["PENDING", "SUBMITTED", "APPROVED", "DENIED"]),
});

/**
 * Admin override: force an application into any of the four user-facing
 * states. Reuses the regular approve/deny/revoke side effects when the
 * source state matches; otherwise writes directly with an audit entry so
 * we don't fire a misleading "your approval was revoked" notification on
 * a user who was never approved.
 */
export async function setApplicationStatus(args: {
  projectId: string;
  applicationId: string;
  target: "PENDING" | "SUBMITTED" | "APPROVED" | "DENIED";
}) {
  const parsed = setStatusSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const app = await prisma.application.findUnique({
    where: { id: parsed.applicationId },
    select: { id: true, projectId: true, status: true },
  });
  if (!app || app.projectId !== parsed.projectId) {
    throw new Error("Application not found");
  }

  const wasApproved = app.status === "APPROVED";

  if (parsed.target === "APPROVED") {
    if (app.status === "APPROVED") return;
    try {
      await approveApplication({
        applicationId: app.id,
        decidedById: session.user.id,
      });
    } catch (e) {
      // The people overview disables the APPROVED button when these gates
      // are unmet; this is the server-side safety net so a stale view can't
      // surface the raw gate error.
      if (e instanceof ClaGateError) {
        throw new Error(
          "CLA gate: this applicant must sign the project's CLA before approval.",
        );
      }
      if (e instanceof ApprovalGateError) {
        throw new Error(
          `Approval gate: this project requires ${e.required} approving review${
            e.required === 1 ? "" : "s"
          } from other reviewers (currently ${e.have}).`,
        );
      }
      throw e;
    }
    await dispatchContributorDecision("approved", app.id);
  } else if (wasApproved) {
    await revokeApplication({
      applicationId: app.id,
      decidedById: session.user.id,
      target: parsed.target,
    });
    await dispatchContributorDecision("revoked", app.id, {
      target: parsed.target,
    });
  } else if (parsed.target === "DENIED") {
    await denyApplication({
      applicationId: app.id,
      decidedById: session.user.id,
      allowResubmit: true,
    });
    await dispatchContributorDecision("denied", app.id);
  } else {
    const now = new Date();
    if (parsed.target === "SUBMITTED") {
      await prisma.application.update({
        where: { id: app.id },
        data: {
          status: "SUBMITTED",
          decidedById: null,
          decidedAt: null,
          allowResubmit: true,
          cooldownUntil: null,
        },
      });
      await recordAudit({
        projectId: app.projectId,
        actorId: session.user.id,
        kind: "application.submitted",
        payload: {
          applicationId: app.id,
          manualOverride: true,
          from: app.status,
        },
      });
    } else {
      // PENDING: stored as DENIED + resubmit + no cooldown so the apply
      // page derives "pending: can apply now".
      await prisma.application.update({
        where: { id: app.id },
        data: {
          status: "DENIED",
          decidedById: session.user.id,
          decidedAt: now,
          allowResubmit: true,
          cooldownUntil: null,
        },
      });
      await recordAudit({
        projectId: app.projectId,
        actorId: session.user.id,
        kind: "application.revoked",
        payload: {
          applicationId: app.id,
          target: "PENDING",
          manualOverride: true,
          from: app.status,
        },
      });
    }
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${app.id}`);
}

const waiveSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: z.string().trim().min(1).max(39),
  reason: z.string().trim().min(1).max(500),
});

/**
 * Grant a CLA waiver for a specific GitHub account straight from the People
 * dialog. Exempts them from signing the CLA. Mirrors the dashboard CLA waiver
 * action (capture ghId, mutation appends the immutable ledger event, audit).
 */
export async function waiveClaForUser(args: {
  projectId: string;
  ghLogin: string;
  reason: string;
}) {
  const parsed = waiveSchema.parse(args);
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const existingUser = await prisma.user.findUnique({
    where: { ghLogin: parsed.ghLogin.toLowerCase() },
    select: { ghId: true },
  });

  const waiver = await grantClaWaiver({
    projectId: parsed.projectId,
    ghLogin: parsed.ghLogin,
    ghId: existingUser?.ghId ?? null,
    reason: parsed.reason,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.waiver_granted",
    payload: {
      waiverId: waiver.id,
      ghLogin: parsed.ghLogin,
      reason: parsed.reason,
      from: "people",
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/people`);
}

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

  // Removing a manual decision changes the gate outcome: re-evaluate the
  // author's open PRs (e.g. a manual DENY that was blocking them is now gone).
  await reGateAuthorPrs({
    projectId: parsed.projectId,
    ghLogin: existing.ghLogin,
    ghId: existing.ghId,
    reason: "manual_decision_removed",
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
    derivedStatus: "SUBMITTED" | "APPROVED" | "DENIED" | "PENDING";
    createdAt: string;
    decidedAt: string | null;
    reason: string | null;
    answersPreview: string;
    allowResubmit: boolean;
    cooldownUntil: string | null;
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
  // CLA coverage for this contributor (null when the project has no CLA enabled).
  cla: {
    required: boolean;
    satisfied: boolean;
    via: "icla" | "ccla" | "waiver" | null;
    needsResign: boolean;
    corporate: { id: string; companyName: string } | null;
    // Most recent individual signature for this account, if any.
    signature: {
      version: number;
      signedAt: string;
      legalName: string;
      status: string;
    } | null;
    currentVersion: number | null;
    // Open PRs from this user currently held open by a failing CLA Check.
    blockedPrCount: number;
  } | null;
  // DCO status (null when DCO is not enabled for the project).
  dco: {
    // Open PRs from this user currently held open by a failing DCO Check.
    blockedPrCount: number;
  } | null;
};

const overviewSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: z.string().min(1).max(80),
});

/**
 * Fetch everything the People-row dialog needs: original application,
 * manual decision (if any), PR list with computed quality scores.
 *
 * Quality score is computed on the fly using the project's *current* config,
 * so flipping a heuristic toggle is reflected immediately without a recompute.
 */
export async function getUserOverview(args: {
  projectId: string;
  ghLogin: string;
}): Promise<UserOverview> {
  const { projectId, ghLogin } = overviewSchema.parse(args);
  await requireProjectRole(projectId, "REVIEWER");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      qualityEnabled: true,
      qualityConfig: true,
      claEnabled: true,
      claRequired: true,
      dcoEnabled: true,
      currentIclaVersionId: true,
    },
  });
  if (!project) throw new Error("Project not found");

  const config = parseQualityConfig(project.qualityConfig);

  const [user, manual] = await Promise.all([
    prisma.user.findUnique({
      where: { ghLogin },
      select: {
        id: true,
        ghId: true,
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
    ? (() => {
        const a = user.applications[0];
        const derivedStatus: "SUBMITTED" | "APPROVED" | "DENIED" | "PENDING" =
          a.status === "DENIED" &&
          a.allowResubmit &&
          (!a.cooldownUntil || a.cooldownUntil <= new Date())
            ? "PENDING"
            : (a.status as "SUBMITTED" | "APPROVED" | "DENIED");
        return {
          id: a.id,
          status: a.status,
          derivedStatus,
          createdAt: a.createdAt.toISOString(),
          decidedAt: a.decidedAt?.toISOString() ?? null,
          reason: a.reason,
          answersPreview: a.answers.slice(0, 800),
          allowResubmit: a.allowResubmit,
          cooldownUntil: a.cooldownUntil?.toISOString() ?? null,
        };
      })()
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
  let claBlockedPrCount = 0;
  let dcoBlockedPrCount = 0;

  for (const c of prChecks) {
    if (c.status === "PENDING") stats.pending += 1;
    if (c.status === "APPROVED") stats.approved += 1;
    if (c.status === "DENIED") stats.denied += 1;
    if (c.status === "BYPASSED") stats.bypassed += 1;
    if (c.closedByApp) stats.closedByApp += 1;
    if (c.status === "CHECK_REQUIRED") {
      if (c.gateReason === "dco_missing") dcoBlockedPrCount += 1;
      else if (c.gateReason === "cla_required" || c.gateReason === "cla_stale")
        claBlockedPrCount += 1;
    }

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

  // CLA coverage (only when the project has a CLA enabled). Matches the gate's
  // own logic via getClaStatus; we additionally surface the latest individual
  // signature + the current required version for context.
  let cla: UserOverview["cla"] = null;
  if (project.claEnabled) {
    const ghIdForLookup = user?.ghId ?? manual?.ghId ?? 0;
    const status = await getClaStatus({
      projectId,
      ghId: ghIdForLookup,
      ghLogin,
    });

    const sig = ghIdForLookup
      ? await prisma.claSignature.findFirst({
          where: { projectId, ghId: ghIdForLookup, kind: "ICLA" },
          orderBy: { signedAt: "desc" },
          select: {
            documentVersion: true,
            signedAt: true,
            legalName: true,
            status: true,
          },
        })
      : null;

    let currentVersion: number | null = null;
    if (project.currentIclaVersionId) {
      const v = await prisma.claDocumentVersion.findUnique({
        where: { id: project.currentIclaVersionId },
        select: { version: true },
      });
      currentVersion = v?.version ?? null;
    }

    cla = {
      required: project.claRequired,
      satisfied: status.satisfied,
      via: status.via ?? null,
      needsResign: !!status.needsResign,
      corporate: status.corporate ?? null,
      signature: sig
        ? {
            version: sig.documentVersion,
            signedAt: sig.signedAt.toISOString(),
            legalName: sig.legalName,
            status: sig.status,
          }
        : null,
      currentVersion,
      blockedPrCount: claBlockedPrCount,
    };
  }

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
    cla,
    dco: project.dcoEnabled ? { blockedPrCount: dcoBlockedPrCount } : null,
  };
}
