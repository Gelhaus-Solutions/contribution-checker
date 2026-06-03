import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  parseLeafPermissions,
  permissionsForRole,
  type ProjectLeafPermission,
} from "@/lib/auth/constants";
import type { Role } from "@/lib/authz";
import { logger } from "@/lib/logger";
import {
  removeProjectMember,
  setMemberLeafPermission,
  setProjectRole,
} from "@/lib/stack-teams";

// Membership mutations dual-write to Stack Auth (the source of truth) FIRST,
// then mirror the local ProjectMember cache (role + expanded leaf permissions).
// On a Stack Auth failure we rethrow so the cache never claims a grant SA
// rejected; the team webhook fixes the inverse case (SA ok, mirror failed).
// Legacy projects without a teamId (pre-backfill) fall back to a local-only
// write with a reconcile-needed warning so they keep working until backfilled.

export async function inviteMemberByGhLogin(args: {
  projectId: string;
  actorId: string;
  ghLogin: string;
  role: Role;
}) {
  const target = await prisma.user.findUnique({
    where: { ghLogin: args.ghLogin },
    select: { id: true, stackUserId: true },
  });

  if (!target) {
    throw new Error(
      `No user with GitHub login "${args.ghLogin}" has signed in yet. They must sign in once before they can be invited.`
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { teamId: true },
  });

  // Stack Auth write first (source of truth). Skip only when we genuinely can't
  // (unmigrated project or unlinked target); those reconcile later.
  if (project?.teamId && target.stackUserId) {
    await setProjectRole(project.teamId, target.stackUserId, args.role);
  } else {
    logger.warn(
      {
        "project.id": args.projectId,
        "gh.login": args.ghLogin,
        hasTeam: !!project?.teamId,
        linked: !!target.stackUserId,
      },
      "teams: inviteMember local-only (reconcile needed; project unmigrated or user unlinked)"
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
    include: { user: { select: { stackUserId: true } } },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }
  if (member.role === "OWNER" && args.role !== "OWNER") {
    throw new Error("Cannot demote the owner. Transfer ownership first.");
  }

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { teamId: true },
  });

  // SA write first. Note: a role change re-baselines the cached leaf set to the
  // role preset; any explicit extra-access leaves are re-applied via the
  // extra-access action (and reconciled by the webhook).
  if (project?.teamId && member.user.stackUserId) {
    await setProjectRole(project.teamId, member.user.stackUserId, args.role);
  } else {
    logger.warn(
      { "project.id": args.projectId, "member.id": args.memberId },
      "teams: changeMemberRole local-only (reconcile needed)"
    );
  }

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
    include: { user: { select: { ghLogin: true, stackUserId: true } } },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }
  if (member.role === "OWNER") {
    throw new Error("Cannot remove the owner. Transfer ownership first.");
  }

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { teamId: true },
  });

  if (project?.teamId && member.user.stackUserId) {
    await removeProjectMember(project.teamId, member.user.stackUserId);
  } else {
    logger.warn(
      { "project.id": args.projectId, "member.id": args.memberId },
      "teams: removeMember local-only (reconcile needed)"
    );
  }

  // deleteMany (not delete): the team webhook may have already removed the cache
  // row in response to the Stack Auth removeUser above; deleteMany is idempotent.
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
 * on top of their role preset. SA write first, then mirror the cached leaf set
 * (union on grant, minus on revoke). Used by the team settings extra-access
 * toggles.
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
    include: { user: { select: { stackUserId: true } } },
  });
  if (!member || member.projectId !== args.projectId) {
    throw new Error("Member not found");
  }

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { teamId: true },
  });
  if (project?.teamId && member.user.stackUserId) {
    await setMemberLeafPermission(
      project.teamId,
      member.user.stackUserId,
      args.permission,
      args.granted
    );
  } else {
    logger.warn(
      { "project.id": args.projectId, "member.id": args.memberId },
      "teams: setMemberExtraPermission local-only (reconcile needed)"
    );
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
