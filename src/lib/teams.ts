import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  parseLeafPermissions,
  permissionsForRole,
  type ProjectLeafPermission,
} from "@/lib/auth/constants";
import type { Role } from "@/lib/authz";

// Project membership is local: ProjectMember holds the role and its expanded
// leaf permissions, and is the truth since the move off Hexclave, whose teams
// these mutations used to write first. Project.teamId stays as a record of the
// team a project once had there.

export async function inviteMemberByGhLogin(args: {
  projectId: string;
  actorId: string;
  ghLogin: string;
  role: Role;
}) {
  const target = await prisma.user.findUnique({
    where: { ghLogin: args.ghLogin },
    select: { id: true },
  });

  if (!target) {
    throw new Error(
      `No user with GitHub login "${args.ghLogin}" has signed in yet. They must sign in once before they can be invited.`
    );
  }

  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: args.projectId, userId: target.id } },
    update: {
      role: args.role,
      permissions: JSON.stringify(permissionsForRole(args.role)),
    },
    create: {
      projectId: args.projectId,
      userId: target.id,
      role: args.role,
      permissions: JSON.stringify(permissionsForRole(args.role)),
    },
  });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "member.invited",
    payload: { ghLogin: args.ghLogin, role: args.role },
  });

  return member;
}

export async function changeMemberRole(args: {
  projectId: string;
  actorId: string;
  memberId: string;
  role: Role;
}) {
  const member = await prisma.projectMember.findUnique({
    where: { id: args.memberId },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }
  if (member.role === "OWNER" && args.role !== "OWNER") {
    throw new Error("Cannot demote the owner. Transfer ownership first.");
  }

  // A role change re-baselines the leaf set to the role preset; any explicit
  // extra-access leaves are re-applied via the extra-access action.
  const updated = await prisma.projectMember.update({
    where: { id: args.memberId },
    data: {
      role: args.role,
      permissions: JSON.stringify(permissionsForRole(args.role)),
    },
  });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "member.role_changed",
    payload: { memberId: args.memberId, from: member.role, to: args.role },
  });

  return updated;
}

export async function removeMember(args: {
  projectId: string;
  actorId: string;
  memberId: string;
}) {
  const member = await prisma.projectMember.findUnique({
    where: { id: args.memberId },
    include: { user: { select: { ghLogin: true } } },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }
  if (member.role === "OWNER") {
    throw new Error("Cannot remove the owner. Transfer ownership first.");
  }

  // deleteMany (not delete), so a second click on a removed member is a no-op.
  await prisma.projectMember.deleteMany({ where: { id: args.memberId } });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "member.removed",
    payload: { ghLogin: member.user.ghLogin },
  });
}

/**
 * Grant or revoke a single explicit "extra access" leaf permission for a member
 * on top of their role preset (union on grant, minus on revoke). Used by the
 * team settings extra-access toggles.
 */
export async function setMemberExtraPermission(args: {
  projectId: string;
  actorId: string;
  memberId: string;
  permission: ProjectLeafPermission;
  granted: boolean;
}) {
  const member = await prisma.projectMember.findUnique({
    where: { id: args.memberId },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }

  const current = parseLeafPermissions(member.permissions);
  const next = new Set<string>(current);
  if (args.granted) next.add(args.permission);
  else next.delete(args.permission);

  await prisma.projectMember.update({
    where: { id: args.memberId },
    data: { permissions: JSON.stringify([...next]) },
  });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: args.granted ? "member.permission_granted" : "member.permission_revoked",
    payload: { memberId: args.memberId, permission: args.permission },
  });
}

export async function listMembers(projectId: string) {
  return prisma.projectMember.findMany({
    where: { projectId },
    include: {
      user: {
        select: {
          id: true,
          ghLogin: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
}
