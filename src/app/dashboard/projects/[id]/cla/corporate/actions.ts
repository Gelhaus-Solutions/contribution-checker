"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications/inbox";
import {
  onClaCoverageChanged,
  onClaCoverageRevoked,
} from "@/lib/cla/post-sign";
import {
  revokeRosterMember as revokeRosterMemberMutation,
  approveCorporateCla as approveCorporateClaMutation,
  rejectCorporateCla as rejectCorporateClaMutation,
} from "@/lib/cla/mutations";

const revokeRosterSchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
});

/**
 * Admin-revoke a single CCLA roster member. Rosters are otherwise self-service
 * by the company; this is the maintainer override. Goes through the shared
 * mutation (append-only ledger + coverage cache invalidation) and audits.
 */
export async function revokeRosterMember(formData: FormData) {
  const parsed = revokeRosterSchema.parse({
    projectId: formData.get("projectId"),
    memberId: formData.get("memberId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const member = await prisma.cclaRosterMember.findUnique({
    where: { id: parsed.memberId },
    select: { projectId: true, corporateId: true, ghLogin: true },
  });
  if (!member || member.projectId !== parsed.projectId) {
    throw new Error("Roster member not found");
  }

  await revokeRosterMemberMutation({
    memberId: parsed.memberId,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.roster_revoked",
    payload: {
      memberId: parsed.memberId,
      corporateId: member.corporateId,
      ghLogin: member.ghLogin,
      via: "admin",
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/corporate`);
}

const approveCorporateSchema = z.object({
  projectId: z.string().min(1),
  corporateId: z.string().min(1),
});

/**
 * Admin-approve a PENDING Corporate CLA. Flips it ACTIVE via the shared mutation
 * (append-only ledger), then re-checks each ACTIVE roster member's open PRs so
 * their gate flips to passing now that the company covers them. Notifies the
 * signatory and audits.
 */
export async function approveCorporateCla(formData: FormData) {
  const parsed = approveCorporateSchema.parse({
    projectId: formData.get("projectId"),
    corporateId: formData.get("corporateId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const corporate = await prisma.corporateCla.findUnique({
    where: { id: parsed.corporateId },
    select: { projectId: true, project: { select: { slug: true } } },
  });
  if (!corporate || corporate.projectId !== parsed.projectId) {
    throw new Error("Corporate CLA not found");
  }

  const result = await approveCorporateClaMutation({
    corporateId: parsed.corporateId,
    actorUserId: session.user.id,
  });

  // Coverage just turned on for the roster: re-check each member's open,
  // CLA-gated PRs (this also invalidates the coverage cache). Members without a
  // known ghId can't be cache-keyed and resolve on their next natural decision.
  for (const ghId of result.activeMemberGhIds) {
    await onClaCoverageChanged({ projectId: parsed.projectId, ghId });
  }

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.ccla_approved",
    payload: {
      corporateId: parsed.corporateId,
      companyName: result.companyName,
    },
  });

  if (result.signatoryUserId) {
    await notifyUser({
      userId: result.signatoryUserId,
      kind: "cla.ccla_approved",
      payload: {
        projectId: parsed.projectId,
        corporateId: parsed.corporateId,
        companyName: result.companyName,
      },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/corporate`);
  revalidatePath(`/p/${corporate.project.slug}/cla/corporate`);
}

const rejectCorporateSchema = z.object({
  projectId: z.string().min(1),
  corporateId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Admin-reject a PENDING Corporate CLA. Flips it REJECTED via the shared mutation
 * (append-only ledger). A pending corporate covered nobody, so no PR re-check is
 * needed. Notifies the signatory (with the optional reason) and audits.
 */
export async function rejectCorporateCla(formData: FormData) {
  const parsed = rejectCorporateSchema.parse({
    projectId: formData.get("projectId"),
    corporateId: formData.get("corporateId"),
    reason:
      typeof formData.get("reason") === "string" &&
      (formData.get("reason") as string).trim().length > 0
        ? formData.get("reason")
        : undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const corporate = await prisma.corporateCla.findUnique({
    where: { id: parsed.corporateId },
    select: { projectId: true, project: { select: { slug: true } } },
  });
  if (!corporate || corporate.projectId !== parsed.projectId) {
    throw new Error("Corporate CLA not found");
  }

  const result = await rejectCorporateClaMutation({
    corporateId: parsed.corporateId,
    actorUserId: session.user.id,
    reason: parsed.reason ?? "",
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.ccla_rejected",
    payload: {
      corporateId: parsed.corporateId,
      companyName: result.companyName,
      reason: parsed.reason ?? "",
    },
  });

  if (result.signatoryUserId) {
    await notifyUser({
      userId: result.signatoryUserId,
      kind: "cla.ccla_rejected",
      payload: {
        projectId: parsed.projectId,
        corporateId: parsed.corporateId,
        companyName: result.companyName,
        reason: parsed.reason ?? "",
      },
    });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/corporate`);
  revalidatePath(`/p/${corporate.project.slug}/cla/corporate`);
}

const revokeCorporateSchema = z.object({
  projectId: z.string().min(1),
  corporateId: z.string().min(1),
});

/**
 * Admin-revoke a whole Corporate CLA (status REVOKED). Roster members are left
 * as-is; an inactive CorporateCla no longer confers coverage on its roster. The
 * signatory's signature stays as the immutable legal record.
 */
export async function revokeCorporateCla(formData: FormData) {
  const parsed = revokeCorporateSchema.parse({
    projectId: formData.get("projectId"),
    corporateId: formData.get("corporateId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const corporate = await prisma.corporateCla.findUnique({
    where: { id: parsed.corporateId },
    select: { projectId: true, status: true, companyName: true },
  });
  if (!corporate || corporate.projectId !== parsed.projectId) {
    throw new Error("Corporate CLA not found");
  }
  if (corporate.status === "REVOKED") {
    throw new Error("Corporate CLA is already revoked");
  }

  // Capture the roster members covered by this corporate BEFORE the revoke, so
  // we can re-gate their open PRs once their coverage is gone.
  const activeMembers = await prisma.cclaRosterMember.findMany({
    where: { corporateId: parsed.corporateId, status: "ACTIVE", ghId: { not: null } },
    select: { ghId: true },
  });

  await prisma.corporateCla.update({
    where: { id: parsed.corporateId },
    data: {
      status: "REVOKED",
      revokedById: session.user.id,
      revokedAt: new Date(),
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.roster_revoked",
    payload: {
      corporateId: parsed.corporateId,
      companyName: corporate.companyName,
      action: "corporate_revoked",
    },
  });

  // Coverage just turned off for the roster: re-gate each member's currently-
  // approved, CLA-gated PRs (and send resign notices). Previously a no-op gap.
  const ghIds = activeMembers
    .map((m) => m.ghId)
    .filter((g): g is number => g != null);
  if (ghIds.length > 0) {
    await onClaCoverageRevoked({ projectId: parsed.projectId, ghIds });
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/corporate`);
}
