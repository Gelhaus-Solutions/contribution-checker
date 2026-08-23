import { cache } from "react";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import {
  parseLeafPermissions,
  permissionsForRole,
  type ProjectLeafPermission,
} from "@/lib/auth/constants";
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
  // Admin-restricted users are fully blocked: send them to the dedicated
  // /restricted page (which uses auth() directly, so no redirect loop). Placed
  // BEFORE the ghId gate so a restricted user is never routed to /welcome.
  if (session.user.restricted) redirect("/restricted");
  // Onboarding gate: every user must have a linked GitHub identity (ghId)
  // before using protected surfaces (the country code is captured in the
  // background, best-effort, and is not gated on). Enforced here (not in edge
  // middleware) because it depends on DB/Hexclave state. The /welcome flow uses
  // auth() directly, so it never re-enters this gate (no redirect loop).
  if (!session.user.ghId) redirect("/welcome");
  return session;
}

/**
 * Non-redirecting restriction check for entry points that do NOT go through
 * requireSession() (public server actions that return a typed error object, and
 * route handlers that return JSON). Returns true when the caller must refuse.
 */
export function isRestricted(session: Session | null): boolean {
  return session?.user.restricted === true;
}

export async function requireSuperAdmin(): Promise<Session> {
  const session = await requireSession();
  if (!session.user.isSuperAdmin) redirect("/dashboard");
  return session;
}

/**
 * Memoized per request: a single project page reads the same membership row
 * from the layout (getProjectPermissions), the page (requireProjectRole /
 * requireProjectPermission) and often an action guard too. Both arguments are
 * plain strings, so React `cache()` keys on them exactly.
 */
export const getProjectMembership = cache(async function getProjectMembership(
  projectId: string,
  userId: string,
) {
  return prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
});

/**
 * Resolve the viewer's effective LEAF permissions for a project, reading the
 * synced ProjectMember.permissions cache (no Stack Auth round-trip). Super-admins
 * get the full leaf set regardless of membership. Returns [] for a non-member
 * non-super-admin. Used by the project layout/nav.
 */
export async function getProjectPermissions(
  projectId: string,
  userId: string,
  isSuperAdmin: boolean,
): Promise<ProjectLeafPermission[]> {
  if (isSuperAdmin) return permissionsForRole("OWNER");
  const membership = await getProjectMembership(projectId, userId);
  if (!membership) return [];
  return parseLeafPermissions(membership.permissions);
}

/** Non-redirecting permission check against the cached leaf set. */
export async function hasProjectPermission(
  projectId: string,
  userId: string,
  permission: ProjectLeafPermission,
  isSuperAdmin: boolean,
): Promise<boolean> {
  if (isSuperAdmin) return true;
  const membership = await getProjectMembership(projectId, userId);
  if (!membership) return false;
  return parseLeafPermissions(membership.permissions).includes(permission);
}

/**
 * Gate a project surface/action by a granular leaf permission. Mirrors the
 * redirect UX of requireProjectRole: non-members go to /dashboard, members
 * lacking the permission go to the project overview. Super-admins always pass,
 * with a synthesized OWNER + full-permission context when they aren't a member
 * (so an instance admin can administer any project without being added to it).
 */
export async function requireProjectPermission(
  projectId: string,
  permission: ProjectLeafPermission,
): Promise<{ session: Session; role: Role; permissions: ProjectLeafPermission[] }> {
  const session = await requireSession();
  const membership = await getProjectMembership(projectId, session.user.id);

  if (!membership) {
    if (session.user.isSuperAdmin) {
      return {
        session,
        role: "OWNER",
        permissions: permissionsForRole("OWNER"),
      };
    }
    redirect("/dashboard");
  }

  const role = membership.role as Role;
  const permissions = parseLeafPermissions(membership.permissions);
  if (session.user.isSuperAdmin) {
    return { session, role, permissions: permissionsForRole("OWNER") };
  }
  if (!permissions.includes(permission)) {
    redirect(`/dashboard/projects/${projectId}`);
  }
  return { session, role, permissions };
}

/**
 * Role-rank gate, kept as a shim during the permission migration. Adds a
 * super-admin bypass: an instance admin who is not a member is no longer
 * wrongly redirected (synthesized as OWNER).
 */
export async function requireProjectRole(
  projectId: string,
  required: Role
): Promise<{ session: Session; role: Role }> {
  const session = await requireSession();
  const membership = await getProjectMembership(projectId, session.user.id);
  if (!membership) {
    if (session.user.isSuperAdmin) return { session, role: "OWNER" };
    redirect("/dashboard");
  }
  const role = membership.role as Role;
  if (session.user.isSuperAdmin) return { session, role };
  if (!roleAtLeast(role, required)) redirect(`/dashboard/projects/${projectId}`);
  return { session, role };
}
