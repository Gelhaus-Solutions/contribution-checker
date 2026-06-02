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
