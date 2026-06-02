import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_FORM_SCHEMA } from "@/lib/applications/schema";
import { permissionsForRole } from "@/lib/auth/constants";
import type { Role } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { createProjectTeam } from "@/lib/stack-teams";

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
        create: {
          userId: args.ownerId,
          role: "OWNER",
          permissions: JSON.stringify(permissionsForRole("OWNER")),
        },
      },
    },
  });

  await recordAudit({
    projectId: project.id,
    actorId: args.ownerId,
    kind: "project.created",
    payload: { slug: project.slug, name: project.name },
  });

  // Dual-write to Stack Auth: create the backing team and grant the owner the
  // project_owner bundle. SA is the source of truth, but a failure here must not
  // fail project creation -- leave teamId null and let the backfill/webhook
  // reconcile it (audited as team.provision_failed).
  const owner = await prisma.user.findUnique({
    where: { id: args.ownerId },
    select: { stackUserId: true },
  });
  if (owner?.stackUserId) {
    try {
      const teamId = await createProjectTeam({
        projectId: project.id,
        displayName: project.name,
        ownerStackUserId: owner.stackUserId,
      });
      await prisma.project.update({
        where: { id: project.id },
        data: { teamId },
      });
      await recordAudit({
        projectId: project.id,
        actorId: args.ownerId,
        kind: "team.provisioned",
        payload: { teamId },
      });
    } catch (e) {
      logger.error(
        { err: e, "project.id": project.id },
        "createProject: Stack Auth team provisioning failed; left teamId null",
      );
      await recordAudit({
        projectId: project.id,
        actorId: args.ownerId,
        kind: "team.provision_failed",
        payload: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  } else {
    logger.warn(
      { "project.id": project.id, "owner.id": args.ownerId },
      "createProject: owner has no stackUserId; skipping team provisioning",
    );
  }

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
