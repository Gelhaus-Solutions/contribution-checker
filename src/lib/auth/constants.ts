/**
 * The project permission catalogue, shared between the server runtime and
 * standalone scripts. Kept free of any "server-only" import so a script can
 * use it under tsx.
 */

// ===========================================================================
// Project permission catalog
// ===========================================================================
//
// A member's project ROLE is one role bundle; granular LEAF permissions gate
// each per-project surface/action. Bundles contain the next tier, so
// `project_admin` confers every `project_reviewer` leaf. ProjectMember stores
// the expanded leaf set (permissionsForRole) plus any explicit extras. These
// were Hexclave team permissions until the move to GPID; the ids are kept so
// the rows already stored keep their meaning.

/** The three project role names (mirrors ProjectMember.role / authz Role). */
export type ProjectRoleName = "OWNER" | "ADMIN" | "REVIEWER";

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
 * Fully-expanded effective LEAF set for a role, the bundles' containment
 * worked out. Written to ProjectMember.permissions so the hot path can gate by
 * leaf. OWNER's leaf set equals ADMIN's (owner-only operations are role
 * checks, not gateable leaves).
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
  // QA is a reviewer activity, not an admin one, so it shares the leaf the PR
  // list already uses rather than the settings leaf staging uses. Sharing an
  // existing leaf for the same reason as above: a new leaf id would be missing
  // from every current member's cached permissions until they resync, which
  // would hide the board from exactly the people who run QA.
  "/qa": "project_prs_view",
  "/settings": "project_settings_manage",
  "/audit": "project_audit_view",
};
