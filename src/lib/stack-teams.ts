import "server-only";
import {
  permissionsForRole,
  PROJECT_ADMIN_PERMISSION,
  PROJECT_LEAF_PERMISSIONS,
  PROJECT_OWNER_PERMISSION,
  PROJECT_REVIEWER_PERMISSION,
  ROLE_PERMISSION,
  type ProjectLeafPermission,
  type ProjectRoleName,
} from "@/lib/auth/constants";
import { logger } from "@/lib/logger";
import { getStackServerApp } from "@/lib/stack";

/**
 * Per-project Hexclave (Stack Auth) team lifecycle. Stack Auth is the source of
 * truth for membership/roles; these primitives perform the SA-side writes and
 * are called SA-first by the dual-writing membership mutations in lib/teams.ts.
 *
 * They LOG-AND-RETHROW on failure: the caller (a membership mutation) must not
 * mirror a grant SA rejected to the local cache, and createProject is the only
 * site that intentionally swallows a failure (project survives, team is
 * reconciled later). Idempotency is achieved by reading current SA state before
 * each write, never by ignoring errors.
 */

/** The three role-bundle team permission ids, highest first. */
const ROLE_BUNDLES: { role: ProjectRoleName; perm: string }[] = [
  { role: "OWNER", perm: PROJECT_OWNER_PERMISSION },
  { role: "ADMIN", perm: PROJECT_ADMIN_PERMISSION },
  { role: "REVIEWER", perm: PROJECT_REVIEWER_PERMISSION },
];
const ALL_ROLE_PERMISSIONS = ROLE_BUNDLES.map((b) => b.perm);
const LEAF_SET = new Set<string>(PROJECT_LEAF_PERMISSIONS);

/**
 * Create the Hexclave team backing a project: the owner is the creator (so they
 * become a member), the project id is stored in server-only metadata (the
 * canonical Project<->team link, redundant with Project.teamId), and the owner
 * is granted the project_owner bundle. Returns the new team id.
 */
export async function createProjectTeam(args: {
  projectId: string;
  displayName: string;
  ownerStackUserId: string;
}): Promise<string> {
  try {
    const app = await getStackServerApp();
    const team = await app.createTeam({
      // Encode the project id in the display name for human readability in the
      // Hexclave dashboard; serverMetadata.projectId is the machine-readable link.
      displayName: `${args.displayName} (project:${args.projectId})`,
      creatorUserId: args.ownerStackUserId,
    });
    const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
    await team.update({
      serverMetadata: { ...meta, projectId: args.projectId },
    });
    await setProjectRole(team.id, args.ownerStackUserId, "OWNER");
    return team.id;
  } catch (e) {
    logger.error(
      { err: e, "project.id": args.projectId },
      "stack-teams: createProjectTeam failed",
    );
    throw e;
  }
}

/**
 * Ensure the user is a member of the team and holds EXACTLY the one role bundle
 * for `role` (recursive containment then covers all the role's leaves). Used by
 * both invite and role-change. Idempotent.
 */
export async function setProjectRole(
  teamId: string,
  stackUserId: string,
  role: ProjectRoleName,
): Promise<void> {
  try {
    const app = await getStackServerApp();
    const team = await app.getTeam(teamId);
    if (!team) throw new Error(`Hexclave team ${teamId} not found`);
    const user = await app.getUser(stackUserId);
    if (!user) throw new Error(`Hexclave user ${stackUserId} not found`);

    const members = await team.listUsers();
    if (!members.some((m) => m.id === stackUserId)) {
      await team.addUser(stackUserId);
    }

    const target = ROLE_PERMISSION[role];
    const direct = await user.listPermissions(team, { recursive: false });
    const heldBundles = new Set(
      direct.map((p) => p.id).filter((id) => ALL_ROLE_PERMISSIONS.includes(id)),
    );
    for (const other of ALL_ROLE_PERMISSIONS) {
      if (other !== target && heldBundles.has(other)) {
        await user.revokePermission(team, other);
      }
    }
    if (!heldBundles.has(target)) {
      await user.grantPermission(team, target);
    }
  } catch (e) {
    logger.error(
      { err: e, "stack.team_id": teamId, "stack.user_id": stackUserId, role },
      "stack-teams: setProjectRole failed",
    );
    throw e;
  }
}

/** Remove a user from the project's team (drops all their team permissions). */
export async function removeProjectMember(
  teamId: string,
  stackUserId: string,
): Promise<void> {
  try {
    const app = await getStackServerApp();
    const team = await app.getTeam(teamId);
    if (!team) throw new Error(`Hexclave team ${teamId} not found`);
    const members = await team.listUsers();
    if (members.some((m) => m.id === stackUserId)) {
      await team.removeUser(stackUserId);
    }
  } catch (e) {
    logger.error(
      { err: e, "stack.team_id": teamId, "stack.user_id": stackUserId },
      "stack-teams: removeProjectMember failed",
    );
    throw e;
  }
}

/**
 * Grant or revoke a single granular LEAF permission for a member (the "extra
 * access" toggles). Operates on DIRECT grants only, so it never tries to revoke
 * a leaf the member only holds via their role bundle.
 */
export async function setMemberLeafPermission(
  teamId: string,
  stackUserId: string,
  leaf: ProjectLeafPermission,
  granted: boolean,
): Promise<void> {
  try {
    const app = await getStackServerApp();
    const team = await app.getTeam(teamId);
    if (!team) throw new Error(`Hexclave team ${teamId} not found`);
    const user = await app.getUser(stackUserId);
    if (!user) throw new Error(`Hexclave user ${stackUserId} not found`);
    const direct = await user.listPermissions(team, { recursive: false });
    const hasDirect = direct.some((p) => p.id === leaf);
    if (granted && !hasDirect) await user.grantPermission(team, leaf);
    if (!granted && hasDirect) await user.revokePermission(team, leaf);
  } catch (e) {
    logger.error(
      { err: e, "stack.team_id": teamId, "stack.user_id": stackUserId, leaf },
      "stack-teams: setMemberLeafPermission failed",
    );
    throw e;
  }
}

/** Delete the project's team (used when a project is deleted). */
export async function deleteProjectTeam(teamId: string): Promise<void> {
  try {
    const app = await getStackServerApp();
    const team = await app.getTeam(teamId);
    if (team) await team.delete();
  } catch (e) {
    logger.error(
      { err: e, "stack.team_id": teamId },
      "stack-teams: deleteProjectTeam failed",
    );
    throw e;
  }
}

/** Highest role bundle held in a permission-id set (recursive expansion). */
function highestRole(ids: Set<string>): ProjectRoleName | null {
  for (const { role, perm } of ROLE_BUNDLES) if (ids.has(perm)) return role;
  return null;
}

/**
 * Read the full roster of a project team as the source of truth, for the webhook
 * reconciler: every member with their derived role (highest bundle held) and
 * effective leaf set (recursive expansion intersected with the leaf catalog).
 * Members holding no role bundle come back with role=null (treated as removed by
 * the reconciler).
 */
export async function readTeamMemberships(teamId: string): Promise<
  { stackUserId: string; role: ProjectRoleName | null; leaves: string[] }[]
> {
  const app = await getStackServerApp();
  const perms = await app.listTeamMemberPermissions(teamId, { recursive: true });
  const byUser = new Map<string, Set<string>>();
  for (const { userId, permissionId } of perms) {
    let set = byUser.get(userId);
    if (!set) byUser.set(userId, (set = new Set()));
    set.add(permissionId);
  }
  const team = await app.getTeam(teamId);
  const members = team ? await team.listUsers() : [];
  return members.map((m) => {
    const ids = byUser.get(m.id) ?? new Set<string>();
    const role = highestRole(ids);
    // Derive leaves from the role preset (local truth) plus any directly-granted
    // extra leaves, rather than relying on SA recursive expansion. This stays
    // correct even if the dashboard-created bundle definitions don't have their
    // containedPermissionIds set.
    const roleLeaves = role ? permissionsForRole(role) : [];
    const extraLeaves = [...ids].filter((id) => LEAF_SET.has(id));
    return {
      stackUserId: m.id,
      role,
      leaves: [...new Set<string>([...roleLeaves, ...extraLeaves])],
    };
  });
}
