import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import type { Role } from "@/lib/authz";

export async function inviteMemberByGhLogin(args: {
  projectId: string;
  actorId: string;
  ghLogin: string;
  role: Role;
}) {
  const target = await prisma.user.findUnique({
    where: { ghLogin: args.ghLogin },
  });

  if (!target) {
    throw new Error(
      `No user with GitHub login "${args.ghLogin}" has signed in yet. They must sign in once before they can be invited.`
    );
  }

  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: args.projectId, userId: target.id } },
    update: { role: args.role },
    create: {
      projectId: args.projectId,
      userId: target.id,
      role: args.role,
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
  const updated = await prisma.projectMember.update({
    where: { id: args.memberId },
    data: { role: args.role },
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
  await prisma.projectMember.delete({ where: { id: args.memberId } });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "member.removed",
    payload: { ghLogin: member.user.ghLogin },
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
