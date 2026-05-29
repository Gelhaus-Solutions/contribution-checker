"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { revokeRosterMember as revokeRosterMemberMutation } from "@/lib/cla/mutations";

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

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/corporate`);
}
