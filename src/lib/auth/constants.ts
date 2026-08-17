/**
 * Auth constants shared between the server-only runtime (src/lib/stack.ts,
 * sync-user.ts) and the standalone backfill script (prisma/backfill-stack-users.ts).
 * Kept free of any "server-only" import so the script can use it under tsx.
 */

/** Project-level Hexclave permission ids (global, not team-scoped). */
export const SUPER_ADMIN_PERMISSION = "super_admin";
export const CREATE_PROJECT_PERMISSION = "create_project";

/** GitHub provider config id in Hexclave + the OAuth scopes we require so the
 * connected-account token can read the numeric id, login, and primary email. */
export const GITHUB_PROVIDER_CONFIG_ID = "github";
export const GITHUB_OAUTH_SCOPES = ["read:user", "user:email"];

// ===========================================================================
// Project permission catalog (Hexclave TEAM permissions, one team per project)
// ===========================================================================
//
// Each project maps to one Hexclave team. A member's project ROLE is the single
// role-bundle team permission they hold in that team; granular LEAF permissions
// gate each per-project surface/action. Bundles contain the next tier via
// Hexclave `containedPermissionIds`, so granting `project_admin` recursively
// confers every `project_reviewer` leaf.
//
// This module is the SINGLE source of truth: the SA provisioner derives the
// permission DEFINITIONS (containedPermissionIds) from PERMISSION_CATALOG, and
// the local cache derives a member's effective leaf set from permissionsForRole.
// They can never drift because both read this map. Kept free of any
// `server-only` import so the standalone tsx backfill scripts can import it.

/** The three project role names (mirrors ProjectMember.role / authz Role). */
export type ProjectRoleName = "OWNER" | "ADMIN" | "REVIEWER";

/** Role bundle (team) permission ids. */
export const PROJECT_OWNER_PERMISSION = "project_owner";
export const PROJECT_ADMIN_PERMISSION = "project_admin";
export const PROJECT_REVIEWER_PERMISSION = "project_reviewer";

/** Map a project role to its single role-bundle team permission id. */
export const ROLE_PERMISSION: Record<ProjectRoleName, string> = {
  OWNER: PROJECT_OWNER_PERMISSION,
  ADMIN: PROJECT_ADMIN_PERMISSION,
  REVIEWER: PROJECT_REVIEWER_PERMISSION,
};

/** All granular leaf permission ids. */
export const PROJECT_LEAF_PERMISSIONS = [
  // reviewer tier (visible/usable by REVIEWER and up)
  "project_overview_view",
  "project_applications_review",
  "project_people_view",
  "project_prs_view",
  "project_form_view",
  "project_quality_view",
  // admin tier
  "project_members_manage",
  "project_prs_manage",
  "project_repos_manage",
  "project_form_manage",
  "project_quality_manage",
  "project_cla_view",
  "project_cla_manage",
  "project_settings_manage",
  "project_audit_view",
] as const;
export type ProjectLeafPermission = (typeof PROJECT_LEAF_PERMISSIONS)[number];

/** Leaves bundled into `project_reviewer` (today's REVIEWER-visible surfaces). */
const REVIEWER_LEAVES: ProjectLeafPermission[] = [
  "project_overview_view",
  "project_applications_review",
  "project_people_view",
  "project_prs_view",
  "project_form_view",
  "project_quality_view",
];

/** Leaves added by `project_admin` on top of the reviewer bundle. */
const ADMIN_LEAVES: ProjectLeafPermission[] = [
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

/**
 * Fully-expanded effective LEAF set for a role, mirroring SA recursive
 * containment. Written to ProjectMember.permissions so the hot path can gate by
 * leaf without an SA round-trip. OWNER's leaf set equals ADMIN's (owner-only
 * operations are role checks, not gateable leaves).
 */
export function permissionsForRole(role: ProjectRoleName): ProjectLeafPermission[] {
  switch (role) {
    case "REVIEWER":
      return [...REVIEWER_LEAVES];
    case "ADMIN":
    case "OWNER":
      return [...REVIEWER_LEAVES, ...ADMIN_LEAVES];
  }
}

/**
 * Permission DEFINITIONS for the SA provisioner, in dependency order (a
 * permission can only contain/grant another that already exists): leaves first,
 * then project_reviewer, project_admin, project_owner.
 */
export const PERMISSION_CATALOG: {
  id: string;
  description: string;
  containedPermissionIds: string[];
}[] = [
  ...PROJECT_LEAF_PERMISSIONS.map((id) => ({
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

/** Human labels for leaf permissions (extra-access toggles UI). */
export const LEAF_LABELS: Record<ProjectLeafPermission, string> = {
  project_overview_view: "View overview",
  project_applications_review: "Review applications",
  project_people_view: "View people",
  project_prs_view: "View PRs",
  project_form_view: "View form",
  project_quality_view: "View quality",
  project_members_manage: "Manage members",
  project_prs_manage: "Manage PRs",
  project_repos_manage: "Manage repos",
  project_form_manage: "Manage form",
  project_quality_manage: "Manage quality",
  project_cla_view: "View CLA",
  project_cla_manage: "Manage CLA",
  project_settings_manage: "Manage settings",
  project_audit_view: "View audit log",
};

/**
 * Tolerant parse of a JSON string[] of leaf permission ids (the
 * ProjectMember.permissions cache). Never throws; drops anything that isn't a
 * currently-known leaf id, so a stale/legacy value can't grant access.
 */
export function parseLeafPermissions(
  raw: string | null | undefined,
): ProjectLeafPermission[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = new Set<string>(PROJECT_LEAF_PERMISSIONS);
    return parsed.filter(
      (x): x is ProjectLeafPermission =>
        typeof x === "string" && known.has(x),
    );
  } catch {
    return [];
  }
}

/**
 * Nav surface (ProjectNav href) -> the leaf permission that gates it. Single
 * contract consumed by nav.tsx; reproduces today's role-rank visibility
 * (Repos/CLA/Settings/Audit were ADMIN-only -> their leaves are admin-tier).
 */
export const NAV_PERMISSION: Record<string, ProjectLeafPermission> = {
  "": "project_overview_view",
  "/applications": "project_applications_review",
  "/people": "project_people_view",
  "/prs": "project_prs_view",
  "/repos": "project_repos_manage",
  "/form": "project_form_view",
  "/quality": "project_quality_view",
  "/cla": "project_cla_manage",
  // Staging routing is settings, just on its own page because it carries
  // per-repo overrides and live state. Sharing the leaf keeps every existing
  // member's cached ProjectMember.permissions valid: a brand-new leaf would be
  // absent from those rows until they resync, hiding the page from admins.
  "/staging": "project_settings_manage",
  "/settings": "project_settings_manage",
  "/audit": "project_audit_view",
};
