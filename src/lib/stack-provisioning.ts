import "server-only";
import type { AdminTeamPermissionDefinition, ServerTeam } from "@hexclave/next";
import { recordAudit } from "@/lib/audit";
import { PERMISSION_CATALOG } from "@/lib/auth/constants";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getStackAdminApp, getStackServerApp } from "@/lib/stack";

/**
 * Stack Auth (Hexclave) provisioning + Instance Admin bootstrap.
 *
 * Off the hot path entirely: provisioning the project permission DEFINITIONS
 * (the hierarchy) and managing the Instance Admin team need the admin app and
 * are triggered by the CLI backfill script or an admin action, never per
 * request. The per-request super-admin check lives in resolveOrgRoles and only
 * inspects the user's own team memberships (see isInstanceAdminTeam).
 */

/** serverMetadata marker (server-only, so client-untrusted) for the Instance
 * Admin team. Lets us discover the team without an env id, and lets
 * resolveOrgRoles recognize it among a user's teams. */
const INSTANCE_ADMIN_MARKER = "instanceAdmin";
export const INSTANCE_ADMIN_TEAM_DISPLAY_NAME = "Instance Admins";

type TeamLike = { id: string; serverMetadata?: unknown };

/**
 * True if a team is the Instance Admin team: either it carries the server-only
 * `instanceAdmin` metadata marker, or its id matches the env pin. Both inputs
 * are server-trusted (serverMetadata is never client-writable; the env pin is
 * operator-set), so this can never be spoofed from the client.
 */
export function isInstanceAdminTeam(team: TeamLike): boolean {
  if (
    env.STACK_INSTANCE_ADMIN_TEAM_ID &&
    team.id === env.STACK_INSTANCE_ADMIN_TEAM_ID
  ) {
    return true;
  }
  const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
  return meta[INSTANCE_ADMIN_MARKER] === true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Idempotently create-or-update the team permission DEFINITIONS from
 * PERMISSION_CATALOG (already in dependency order: leaves, then reviewer,
 * admin, owner, so contained ids always pre-exist). Each definition is
 * try/caught so one failure doesn't abort the rest; throws only if every
 * definition failed (so the caller can surface a hard error).
 */
export async function provisionTeamPermissionDefinitions(): Promise<{
  created: string[];
  updated: string[];
  skipped: string[];
}> {
  const admin = await getStackAdminApp();

  // Page existing definitions into a lookup.
  const existing = new Map<string, AdminTeamPermissionDefinition>();
  let cursor: string | undefined;
  do {
    const page = await admin.listTeamPermissionDefinitionsPaginated({
      limit: 100,
      cursor,
    });
    for (const def of page.items) existing.set(def.id, def);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  let errors = 0;

  for (const def of PERMISSION_CATALOG) {
    try {
      const cur = existing.get(def.id);
      if (!cur) {
        await admin.createTeamPermissionDefinition({
          id: def.id,
          description: def.description,
          containedPermissionIds: def.containedPermissionIds,
        });
        created.push(def.id);
      } else if (
        cur.description !== def.description ||
        !sameSet(cur.containedPermissionIds, def.containedPermissionIds)
      ) {
        await admin.updateTeamPermissionDefinition(def.id, {
          description: def.description,
          containedPermissionIds: def.containedPermissionIds,
        });
        updated.push(def.id);
      } else {
        skipped.push(def.id);
      }
    } catch (e) {
      errors += 1;
      logger.error(
        { err: e, "stack.permission_id": def.id },
        "provision: team permission definition failed",
      );
    }
  }

  if (errors === PERMISSION_CATALOG.length) {
    throw new Error("Failed to provision any team permission definitions");
  }
  logger.info(
    {
      "provision.created": created.length,
      "provision.updated": updated.length,
      "provision.skipped": skipped.length,
      "provision.errors": errors,
    },
    "provision: team permission definitions reconciled",
  );
  return { created, updated, skipped };
}

/** Find the Instance Admin team by scanning all teams for the marker/env pin. */
async function findInstanceAdminTeam(): Promise<ServerTeam | null> {
  const app = await getStackServerApp();
  if (env.STACK_INSTANCE_ADMIN_TEAM_ID) {
    const pinned = await app.getTeam(env.STACK_INSTANCE_ADMIN_TEAM_ID);
    if (pinned) return pinned;
    logger.warn(
      { "stack.team_id": env.STACK_INSTANCE_ADMIN_TEAM_ID },
      "instance admin team id is set but no such team exists; falling back to discovery",
    );
  }
  let cursor: string | undefined;
  do {
    const page = await app.listTeams({ limit: 100, cursor });
    for (const team of page) if (isInstanceAdminTeam(team)) return team;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

/**
 * Resolve the Instance Admin team, creating it (with the server-only marker) if
 * it does not exist yet. Used by the bootstrap and the admin toggle. After the
 * first creation the operator should pin STACK_INSTANCE_ADMIN_TEAM_ID to the
 * logged team id (env is read-only at runtime, so we can't persist it).
 */
export async function ensureInstanceAdminTeam(): Promise<ServerTeam> {
  const found = await findInstanceAdminTeam();
  if (found) return found;

  const app = await getStackServerApp();
  const team = await app.createTeam({
    displayName: INSTANCE_ADMIN_TEAM_DISPLAY_NAME,
  });
  const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
  await team.update({
    serverMetadata: { ...meta, [INSTANCE_ADMIN_MARKER]: true },
  });
  logger.info(
    { "stack.team_id": team.id },
    "created Instance Admin team; pin STACK_INSTANCE_ADMIN_TEAM_ID to this id",
  );
  return team;
}

/**
 * One-time seed of the Instance Admin team from the SUPER_ADMINS env CSV. Guards
 * on a durable `instance_admins_seeded` audit event so re-running (boot, CLI,
 * admin action) never re-adds someone an admin later removed from the team. This
 * is the ONLY place SUPER_ADMINS confers admin: it bootstraps team membership
 * once, after which the team is the live authority (env is no longer consulted
 * by resolveOrgRoles).
 */
export async function bootstrapInstanceAdmins(): Promise<{
  seeded: string[];
  skipped: boolean;
}> {
  const already = await prisma.auditEvent.findFirst({
    where: { kind: "instance_admins_seeded" },
    select: { id: true },
  });
  if (already) return { seeded: [], skipped: true };

  const logins = env.superAdmins; // lowercased CSV
  const team = await ensureInstanceAdminTeam();
  const seeded: string[] = [];

  for (const login of logins) {
    const user = await prisma.user.findFirst({
      where: { ghLogin: { equals: login, mode: "insensitive" } },
      select: { stackUserId: true },
    });
    if (!user?.stackUserId) {
      logger.warn(
        { "gh.login": login },
        "bootstrap: super-admin login not linked to Hexclave yet; skipping (re-run after they sign in)",
      );
      continue;
    }
    try {
      await team.addUser(user.stackUserId);
      seeded.push(login);
    } catch (e) {
      logger.error(
        { err: e, "gh.login": login },
        "bootstrap: addUser to Instance Admin team failed",
      );
    }
  }

  await recordAudit({
    projectId: null,
    actorId: null,
    kind: "instance_admins_seeded",
    payload: { seeded, total: logins.length },
  });
  logger.info(
    { "bootstrap.seeded": seeded.length, "bootstrap.total": logins.length },
    "bootstrap: Instance Admin team seeded from SUPER_ADMINS",
  );
  return { seeded, skipped: false };
}

/**
 * Idempotent "make Stack Auth ready" entrypoint: reconcile the permission
 * definitions, then one-time seed the Instance Admin team. Called by the
 * /admin provisioning action and the CLI backfill. Both steps are safe to
 * re-run. Records a single app-level audit event.
 */
export async function provisionStackAuth(actorId: string | null = null): Promise<{
  definitions: { created: string[]; updated: string[]; skipped: string[] };
  bootstrap: { seeded: string[]; skipped: boolean };
}> {
  const definitions = await provisionTeamPermissionDefinitions();
  const bootstrap = await bootstrapInstanceAdmins();
  await recordAudit({
    projectId: null,
    actorId,
    kind: "stack.permissions_provisioned",
    payload: {
      created: definitions.created,
      updated: definitions.updated,
      bootstrapSeeded: bootstrap.seeded,
      bootstrapSkipped: bootstrap.skipped,
    },
  });
  return { definitions, bootstrap };
}
