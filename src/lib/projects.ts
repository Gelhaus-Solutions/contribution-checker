import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_FORM_SCHEMA } from "@/lib/applications/schema";
import type { Role } from "@/lib/authz";

export async function createProject(args: {
  ownerId: string;
  slug: string;
  name: string;
  description?: string;
}) {
  const project = await prisma.project.create({
    data: {
      slug: args.slug,
      name: args.name,
      description: args.description,
      formSchema: JSON.stringify(DEFAULT_FORM_SCHEMA),
      members: {
        create: { userId: args.ownerId, role: "OWNER" },
      },
    },
  });

  await recordAudit({
    projectId: project.id,
    actorId: args.ownerId,
    kind: "project.created",
    payload: { slug: project.slug, name: project.name },
  });

  return project;
}

export async function listProjectsForUser(userId: string) {
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    include: {
      project: {
        include: {
          _count: {
            select: { applications: true, repos: true, members: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return memberships.map((m) => ({
    role: m.role as Role,
    project: m.project,
  }));
}

export async function getProjectForViewer(projectId: string, userId: string) {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: {
      project: {
        include: {
          _count: {
            select: { applications: true, repos: true, members: true },
          },
        },
      },
    },
  });
  if (!membership) return null;
  return { role: membership.role as Role, project: membership.project };
}

export async function listAppliedProjectsForUser(userId: string) {
  const apps = await prisma.application.findMany({
    where: { userId },
    include: { project: { select: { id: true, slug: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return apps;
}
