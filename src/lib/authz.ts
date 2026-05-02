import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";

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
  const session = (await auth()) as Session | null;
  if (!session?.user) redirect("/api/auth/signin");
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
