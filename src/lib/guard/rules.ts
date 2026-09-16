/**
 * The catalog of guarded path rules, and the parsing of the project's choice.
 *
 * This is the same shape `DIGEST_SECTIONS` has for the staging digest and
 * `ALL_HEURISTICS` has for quality scoring: a list of `{ id, label, hint }` the
 * settings UI maps over, so adding a rule is an append here and nothing else.
 * No migration, no new column, no UI work.
 *
 * Six of the rules are the file groups the staging digest already classifies
 * (`src/lib/github/file-groups.ts`); the rest are this codebase's own sharp
 * edges. A project picks the subset it wants and can add globs of its own.
 */

import { FILE_GROUPS, type FileGroupId } from "@/lib/github/file-groups";

export type GuardRule = {
  id: string;
  label: string;
  hint: string;
  matches: (path: string) => boolean;
};

/** Hints for the six rules whose predicates come from the digest's groups. The
 * digest's own labels describe a release note; these describe a risk. */
const GROUP_HINTS: Record<FileGroupId, string> = {
  migrations: "Migration files, which run against production on deploy.",
  schema: "Schema definitions. A column dropped here is data gone.",
  dependencies:
    "Package manifests and lockfiles, where a supply-chain change hides.",
  workflows:
    "Workflow and pipeline definitions, which run with the repository's secrets.",
  infra: "Dockerfiles, compose files, Terraform, Helm, platform config.",
  tooling: "Build, bundler, linter, formatter and test-runner config.",
};

export const GUARD_RULES: GuardRule[] = [
  ...FILE_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    hint: GROUP_HINTS[g.id],
    matches: g.matches,
  })),
  {
    id: "temporal",
    label: "Temporal workflows and activities",
    hint: "Workflow code is versioned by replay: an edit can break histories that are already running.",
    matches: (p) =>
      /(^|\/)(worker|workers)\/(workflows|activities)\//i.test(p) ||
      /(^|\/)temporal\/contracts\.[cm]?[jt]sx?$/i.test(p) ||
      /(^|\/)(workflows|activities)\/.*\.[cm]?[jt]sx?$/i.test(p),
  },
  {
    id: "auth",
    label: "Authentication and authorization",
    hint: "Session handling, middleware and permission checks. A mistake here is not visible in the diff's size.",
    matches: (p) =>
      /(^|\/)(auth|authz|authn|permissions?|rbac)\.[cm]?[jt]sx?$/i.test(p) ||
      /(^|\/)(auth|authz|permissions?)\//i.test(p) ||
      /(^|\/)middleware\.[cm]?[jt]sx?$/i.test(p),
  },
  {
    id: "secrets",
    label: "Secrets and environment declarations",
    hint: "Files that name environment variables or hold credentials config.",
    matches: (p) => {
      const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
      return (
        base.startsWith(".env") ||
        base.endsWith(".env") ||
        /^env\.[cm]?[jt]sx?$/.test(base) ||
        /(^|\/)(secrets?|vault)\//i.test(p)
      );
    },
  },
];

export type GuardRuleId = string;

export const ALL_GUARD_RULE_IDS: GuardRuleId[] = GUARD_RULES.map((r) => r.id);

const KNOWN_RULES = new Set<string>(ALL_GUARD_RULE_IDS);

/**
 * Parse `Project.guardRules` into the set of rules in force.
 *
 * Unreadable or missing config falls back to *everything*, the same direction
 * `parseDigestSections` takes and for a sharper reason: a guard is only worth
 * having if it cannot quietly stop guarding. Over-guarding is loud (a check goes
 * red, and the settings page shows why), while a corrupt column that read as
 * "nothing is guarded" would leave a project believing it had a gate it no
 * longer has. Unknown ids are dropped, which lets a rule be retired from the
 * catalog without a data migration.
 */
export function parseGuardRules(
  raw: string | null | undefined,
): Set<GuardRuleId> {
  if (!raw) return new Set(ALL_GUARD_RULE_IDS);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed.filter((id): id is GuardRuleId =>
          typeof id === "string" ? KNOWN_RULES.has(id) : false,
        ),
      );
    }
  } catch {
    /* fall through to the permissive default */
  }
  return new Set(ALL_GUARD_RULE_IDS);
}

/** Serialize for the column, in catalog order so the stored value is stable and
 * a no-op save cannot look like a change in the audit log. */
export function serializeGuardRules(ids: Iterable<GuardRuleId>): string {
  const wanted = new Set<string>([...ids]);
  return JSON.stringify(ALL_GUARD_RULE_IDS.filter((id) => wanted.has(id)));
}
