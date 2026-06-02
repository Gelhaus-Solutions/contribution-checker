import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import type { Session } from "@/lib/auth-types";

export type Role = "OWNER" | "ADMIN" | "REVIEWER";

const ROLE_RANK: Record<Role, number> = {
  REVIEWER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export async function requireSession(): Promise<Session> {
  const session = await auth();
  if (!session?.user) redirect("/handler/sign-in");
  // Onboarding gate: every user must have a linked GitHub identity (ghId) and a
  // country before using protected surfaces. Enforced here (not in edge
  // middleware) because it depends on DB/Hexclave state. The /welcome flow uses
  // auth() directly, so it never re-enters this gate (no redirect loop).
  if (!session.user.ghId || !session.user.country) redirect("/welcome");
  return session;
}

export async function requireSuperAdmin(): Promise<Session> {
  const session = await requireSession();
  if (!session.user.isSuperAdmin) redirect("/dashboard");
  return session;
}

export async function getProjectMembership(projectId: string, userId: string) {
  return prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
}

export async function requireProjectRole(
  projectId: string,
  required: Role
): Promise<{ session: Session; role: Role }> {
  const session = await requireSession();
  const membership = await getProjectMembership(projectId, session.user.id);
  if (!membership) redirect("/dashboard");
  const role = membership.role as Role;
  if (!roleAtLeast(role, required)) redirect(`/dashboard/projects/${projectId}`);
  return { session, role };
}
