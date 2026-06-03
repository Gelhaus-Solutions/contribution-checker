/**
 * One-off backfill + reconcile for Hexclave (Stack Auth) TEAMS & PERMISSIONS.
 *
 * Run AFTER prisma/backfill-stack-users.ts (users must be linked first). It:
 *   1. Provisions the team permission DEFINITIONS (the project_owner ⊃
 *      project_admin ⊃ project_reviewer hierarchy + leaf permissions),
 *      idempotently (create-or-update).
 *   2. One-time seeds the Instance Admin team from SUPER_ADMINS (guarded by an
 *      `instance_admins_seeded` audit event so re-runs never re-add removed
 *      admins).
 *   3. For every Project without a teamId, creates + links a Hexclave team and
 *      grants each linked member their role bundle (+ team membership), then
 *      writes the ProjectMember.permissions cache.
 *
 * Idempotent and re-runnable: projects with a teamId are skipped for creation,
 * grants tolerate already-held, and the permissions cache is recomputed.
 *
 *   pnpm db:backfill:stack-teams            # apply
 *   DRY_RUN=1 pnpm db:backfill:stack-teams  # report only, no writes
 *
 * Requires the Hexclave env vars incl. STACK_SUPER_SECRET_ADMIN_KEY (export it
 * if it lives in Vault). STACK_INSTANCE_ADMIN_TEAM_ID is optional (pin).
 */
import { PrismaClient } from "@prisma/client";
import { StackAdminApp, StackServerApp, type ServerTeam } from "@hexclave/next";

// --- Catalog, inlined (keep in sync with src/lib/auth/constants.ts) ---------
// The script ships in the Docker image with prisma/ but not src/, so it can't
// import the catalog. These MUST match constants.ts exactly.
const PROJECT_OWNER_PERMISSION = "project_owner";
const PROJECT_ADMIN_PERMISSION = "project_admin";
const PROJECT_REVIEWER_PERMISSION = "project_reviewer";

const ROLE_PERMISSION: Record<string, string> = {
  OWNER: PROJECT_OWNER_PERMISSION,
  ADMIN: PROJECT_ADMIN_PERMISSION,
  REVIEWER: PROJECT_REVIEWER_PERMISSION,
};
const ALL_BUNDLES = [
  PROJECT_OWNER_PERMISSION,
  PROJECT_ADMIN_PERMISSION,
  PROJECT_REVIEWER_PERMISSION,
];

const REVIEWER_LEAVES = [
  "project_overview_view",
  "project_applications_review",
  "project_people_view",
  "project_prs_view",
  "project_form_view",
  "project_quality_view",
];
const ADMIN_LEAVES = [
  "project_members_manage",
  "project_prs_manage",
  "project_repos_manage",
  "project_form_manage",
  "project_quality_manage",
  "project_cla_view",
  "project_cla_manage",
  "project_settings_manage",
  "project_audit_view",
];
const ALL_LEAVES = [...REVIEWER_LEAVES, ...ADMIN_LEAVES];

function permissionsForRole(role: string): string[] {
  if (role === "REVIEWER") return [...REVIEWER_LEAVES];
  return [...REVIEWER_LEAVES, ...ADMIN_LEAVES]; // ADMIN + OWNER
}

// Dependency order: leaves, then reviewer, admin, owner.
const PERMISSION_CATALOG: {
  id: string;
  description: string;
  containedPermissionIds: string[];
}[] = [
  ...ALL_LEAVES.map((id) => ({
    id,
    description: `Project leaf permission: ${id}`,
    containedPermissionIds: [] as string[],
  })),
  {
    id: PROJECT_REVIEWER_PERMISSION,
    description: "Project reviewer (read + review applications)",
    containedPermissionIds: [...REVIEWER_LEAVES],
  },
  {
    id: PROJECT_ADMIN_PERMISSION,
    description: "Project admin (manage settings, repos, CLA, members)",
    containedPermissionIds: [PROJECT_REVIEWER_PERMISSION, ...ADMIN_LEAVES],
  },
  {
    id: PROJECT_OWNER_PERMISSION,
    description: "Project owner (full control incl. transfer/delete)",
    containedPermissionIds: [PROJECT_ADMIN_PERMISSION],
  },
];

const INSTANCE_ADMIN_MARKER = "instanceAdmin";
const INSTANCE_ADMIN_TEAM_DISPLAY_NAME = "Instance Admins";

const DRY_RUN = process.env.DRY_RUN === "1";

const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Export the Hexclave env vars first.`);
  return v;
}

const baseOpts = {
  tokenStore: "memory" as const,
  projectId: requireEnv("STACK_PROJECT_ID"),
  publishableClientKey: requireEnv("STACK_PUBLISHABLE_CLIENT_KEY"),
  secretServerKey: requireEnv("STACK_SECRET_SERVER_KEY"),
  baseUrl: process.env.STACK_API_URL,
};
// Skip the admin-only permission-definition provisioning when there's no
// super-secret admin key (or SKIP_PROVISION=1). Some Hexclave instances don't
// expose an admin key; in that case create the definitions once in the
// dashboard (see the checklist printed at startup) and the rest of the backfill
// runs on the server key alone (team creation + role grants).
const SKIP_PROVISION =
  process.env.SKIP_PROVISION === "1" ||
  !process.env.STACK_SUPER_SECRET_ADMIN_KEY;

const stackApp = new StackServerApp(baseOpts);
const adminApp = SKIP_PROVISION
  ? null
  : new StackAdminApp({
      ...baseOpts,
      superSecretAdminKey: requireEnv("STACK_SUPER_SECRET_ADMIN_KEY"),
    });

/** Human checklist of the team permission definitions to create in the
 * dashboard when provisioning is skipped (ids must match PERMISSION_CATALOG). */
function printDefinitionChecklist(): void {
  console.log(
    "Skipping permission-definition provisioning (no admin key / SKIP_PROVISION).",
  );
  console.log(
    "Create these TEAM permissions in the Hexclave dashboard (leaves first, then bundles):",
  );
  for (const def of PERMISSION_CATALOG) {
    const contains = def.containedPermissionIds.length
      ? ` -> contains: ${def.containedPermissionIds.join(", ")}`
      : "";
    console.log(`  - ${def.id}${contains}`);
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function provisionDefinitions(): Promise<void> {
  if (!adminApp) return; // server-key-only mode; definitions created in dashboard
  const existing = new Map<string, { containedPermissionIds: string[]; description?: string }>();
  let cursor: string | undefined;
  do {
    const page = await adminApp.listTeamPermissionDefinitionsPaginated({ limit: 100, cursor });
    for (const d of page.items) existing.set(d.id, d);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  for (const def of PERMISSION_CATALOG) {
    const cur = existing.get(def.id);
    if (!cur) {
      console.log(`${DRY_RUN ? "[dry-run] " : ""}create definition ${def.id}`);
      if (!DRY_RUN) {
        await adminApp.createTeamPermissionDefinition({
          id: def.id,
          description: def.description,
          containedPermissionIds: def.containedPermissionIds,
        });
      }
    } else if (
      cur.description !== def.description ||
      !sameSet(cur.containedPermissionIds, def.containedPermissionIds)
    ) {
      console.log(`${DRY_RUN ? "[dry-run] " : ""}update definition ${def.id}`);
      if (!DRY_RUN) {
        await adminApp.updateTeamPermissionDefinition(def.id, {
          description: def.description,
          containedPermissionIds: def.containedPermissionIds,
        });
      }
    }
  }
}

function isInstanceAdminTeam(team: ServerTeam): boolean {
  const pin = process.env.STACK_INSTANCE_ADMIN_TEAM_ID;
  if (pin && team.id === pin) return true;
  const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
  return meta[INSTANCE_ADMIN_MARKER] === true;
}

async function ensureInstanceAdminTeam(): Promise<ServerTeam | null> {
  const pin = process.env.STACK_INSTANCE_ADMIN_TEAM_ID;
  if (pin) {
    const t = await stackApp.getTeam(pin);
    if (t) return t;
  }
  let cursor: string | undefined;
  do {
    const page = await stackApp.listTeams({ limit: 100, cursor });
    for (const t of page) if (isInstanceAdminTeam(t)) return t;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (DRY_RUN) {
    console.log("[dry-run] would create Instance Admin team");
    return null;
  }
  const team = await stackApp.createTeam({ displayName: INSTANCE_ADMIN_TEAM_DISPLAY_NAME });
  const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
  await team.update({ serverMetadata: { ...meta, [INSTANCE_ADMIN_MARKER]: true } });
  console.log(`created Instance Admin team ${team.id} (pin STACK_INSTANCE_ADMIN_TEAM_ID to it)`);
  return team;
}

async function bootstrapInstanceAdmins(): Promise<void> {
  const already = await prisma.auditEvent.findFirst({
    where: { kind: "instance_admins_seeded" },
    select: { id: true },
  });
  if (already) {
    console.log("instance admins already seeded; skipping bootstrap");
    return;
  }
  const logins = (process.env.SUPER_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (logins.length === 0) {
    console.log("SUPER_ADMINS empty; nothing to bootstrap");
  }
  const team = await ensureInstanceAdminTeam();
  const seeded: string[] = [];
  if (team) {
    for (const login of logins) {
      const user = await prisma.user.findFirst({
        where: { ghLogin: { equals: login, mode: "insensitive" } },
        select: { stackUserId: true },
      });
      if (!user?.stackUserId) {
        console.warn(`bootstrap: ${login} not linked yet; skipping`);
        continue;
      }
      console.log(`${DRY_RUN ? "[dry-run] " : ""}add ${login} to Instance Admin team`);
      if (!DRY_RUN) {
        try {
          await team.addUser(user.stackUserId);
          seeded.push(login);
        } catch (e) {
          console.error(`bootstrap: addUser ${login} failed`, e);
        }
      }
    }
  }
  if (!DRY_RUN) {
    await prisma.auditEvent.create({
      data: {
        projectId: null,
        actorId: null,
        kind: "instance_admins_seeded",
        payload: JSON.stringify({ seeded, total: logins.length }),
      },
    });
  }
}

async function setRole(teamId: string, stackUserId: string, role: string): Promise<void> {
  const team = await stackApp.getTeam(teamId);
  const user = await stackApp.getUser(stackUserId);
  if (!team || !user) throw new Error(`missing team/user (${teamId}/${stackUserId})`);
  const members = await team.listUsers();
  if (!members.some((m) => m.id === stackUserId)) await team.addUser(stackUserId);
  const direct = await user.listPermissions(team, { recursive: false });
  const held = new Set(direct.map((p) => p.id));
  const target = ROLE_PERMISSION[role] ?? PROJECT_REVIEWER_PERMISSION;
  for (const b of ALL_BUNDLES) {
    if (b !== target && held.has(b)) await user.revokePermission(team, b);
  }
  if (!held.has(target)) await user.grantPermission(team, target);
}

type Counts = {
  projectsTotal: number;
  teamsCreated: number;
  projectsSkipped: number;
  membersGranted: number;
  membersUnlinked: number;
  errors: number;
};

async function backfillProject(
  project: { id: string; name: string; teamId: string | null },
  counts: Counts,
): Promise<void> {
  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    select: {
      id: true,
      role: true,
      user: { select: { stackUserId: true } },
    },
    orderBy: { role: "asc" },
  });

  let teamId = project.teamId;

  if (!teamId) {
    const owner = members.find((m) => m.role === "OWNER" && m.user.stackUserId);
    if (!owner?.user.stackUserId) {
      console.warn(`skip project ${project.id}: no linked OWNER to create the team`);
      counts.errors++;
      return;
    }
    if (DRY_RUN) {
      console.log(`[dry-run] would create team for project ${project.id}`);
      counts.teamsCreated++;
    } else {
      const team = await stackApp.createTeam({
        displayName: `${project.name} (project:${project.id})`,
        creatorUserId: owner.user.stackUserId,
      });
      const meta = (team.serverMetadata as Record<string, unknown> | null) ?? {};
      await team.update({ serverMetadata: { ...meta, projectId: project.id } });
      await prisma.project.update({ where: { id: project.id }, data: { teamId: team.id } });
      teamId = team.id;
      counts.teamsCreated++;
    }
  } else {
    counts.projectsSkipped++;
  }

  for (const m of members) {
    if (!m.user.stackUserId) {
      counts.membersUnlinked++;
      continue;
    }
    const perms = JSON.stringify(permissionsForRole(m.role));
    if (DRY_RUN) {
      console.log(`[dry-run]   grant ${m.role} to ${m.user.stackUserId}`);
      counts.membersGranted++;
      continue;
    }
    try {
      if (teamId) await setRole(teamId, m.user.stackUserId, m.role);
      await prisma.projectMember.update({ where: { id: m.id }, data: { permissions: perms } });
      counts.membersGranted++;
    } catch (e) {
      console.error(`error project ${project.id} member ${m.id}: setRole failed`, e);
      counts.errors++;
    }
  }
}

async function main(): Promise<void> {
  console.log("== provisioning team permission definitions ==");
  if (SKIP_PROVISION) {
    printDefinitionChecklist();
  } else {
    await provisionDefinitions();
  }

  console.log("== bootstrapping Instance Admin team ==");
  await bootstrapInstanceAdmins();

  console.log("== backfilling project teams ==");
  const counts: Counts = {
    projectsTotal: 0,
    teamsCreated: 0,
    projectsSkipped: 0,
    membersGranted: 0,
    membersUnlinked: 0,
    errors: 0,
  };
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.project.findMany({
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, name: true, teamId: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    for (const project of batch) {
      counts.projectsTotal++;
      try {
        await backfillProject(project, counts);
      } catch (e) {
        console.error(`error project ${project.id}: unexpected`, e);
        counts.errors++;
      }
    }
  }

  console.log("\nTeams backfill summary:", JSON.stringify(counts, null, 2));
  if (DRY_RUN) console.log("(dry run: no writes performed)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
