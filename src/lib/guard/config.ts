/**
 * Project-level path-guard configuration that lives in JSON columns.
 *
 * Parsed here rather than with a bare `JSON.parse` at the call site, per the
 * house rule for JSON columns: the column is a string that a migration, a hand
 * edit or an older version could have left in any shape, and a settings page
 * that throws is a settings page nobody can use to fix the value.
 *
 * Note the deliberate asymmetry with `parseGuardRules`, which is permissive-
 * *open* (corrupt reads as every rule on). Globs and approvers are permissive-
 * *closed*, and both directions point the same way: a corrupt rule list must not
 * stop guarding, and a corrupt approver list must not start handing out unlocks
 * to logins nobody configured. When in doubt, fail toward asking a human.
 */

import { parseGuardRules, type GuardRuleId } from "@/lib/guard/rules";

const MAX_GLOBS = 60;
const MAX_APPROVERS = 100;
const MAX_ENTRY_LENGTH = 200;

export type GuardUnlockMode = "either" | "both";

/** The settings actually in force for one project. */
export type ResolvedGuardConfig = {
  /** True only when the guard is switched on AND has something to guard. */
  enabled: boolean;
  rules: Set<GuardRuleId>;
  globs: string[];
  approvers: string[];
  unlockMode: GuardUnlockMode;
  unlockLabel: string;
  blockedLabel: string;
};

export type GuardProject = {
  guardEnabled: boolean;
  guardRules: string;
  guardGlobs: string;
  guardApprovers: string;
  guardUnlockMode: string;
  labelGuardUnlock: string;
  labelGuardBlocked: string;
};

/** The Prisma `select` literal for `GuardProject`, so every read site asks for
 * the same columns and adding a setting is one edit. */
export const guardProjectSelect = {
  guardEnabled: true,
  guardRules: true,
  guardGlobs: true,
  guardApprovers: true,
  guardUnlockMode: true,
  labelGuardUnlock: true,
  labelGuardBlocked: true,
} as const;

/**
 * Fold the columns into the settings in force.
 *
 * `enabled` is AND-ed against "has at least one rule or glob" so a single read
 * answers the first question the guard asks. A project that switched the guard
 * on and then unticked everything has configured a gate that guards nothing, and
 * publishing a green check on every PR to say so would be noise, not
 * information: the right answer there is the fourth state the other checks have,
 * no check at all.
 */
export function resolveGuardConfig(project: GuardProject): ResolvedGuardConfig {
  const rules = parseGuardRules(project.guardRules);
  const globs = parseGuardGlobs(project.guardGlobs);
  return {
    enabled: project.guardEnabled && (rules.size > 0 || globs.length > 0),
    rules,
    globs,
    approvers: parseGuardApprovers(project.guardApprovers),
    unlockMode: parseUnlockMode(project.guardUnlockMode),
    unlockLabel: project.labelGuardUnlock,
    blockedLabel: project.labelGuardBlocked,
  };
}

/** Anything but the literal "both" reads as "either": an unrecognized value
 * should relax the unlock, not silently start demanding a second signal the
 * settings page is not showing as required. */
function parseUnlockMode(raw: string | null | undefined): GuardUnlockMode {
  return raw === "both" ? "both" : "either";
}

// --- globs -------------------------------------------------------------------

/** Trim, drop blanks, drop leading `./` and `/`, de-duplicate, cap. */
function normalizeGlobs(entries: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const glob = entry
      .trim()
      .replace(/^\.?\//, "")
      .slice(0, MAX_ENTRY_LENGTH);
    if (glob.length === 0) continue;
    if (glob.startsWith("#")) continue; // let people comment their list
    if (seen.has(glob)) continue;
    seen.add(glob);
    out.push(glob);
    if (out.length >= MAX_GLOBS) break;
  }
  return out;
}

export function parseGuardGlobs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeGlobs(parsed);
  } catch {
    return [];
  }
}

/** Shares `normalizeGlobs` with the parser so a value written here always reads
 * back identically, which is what keeps a no-op save out of the audit log. */
export function serializeGuardGlobs(globs: string[]): string {
  return JSON.stringify(normalizeGlobs(globs));
}

/** Read the textarea on the settings page: one glob per line. */
export function parseGuardGlobsInput(raw: string | null): string[] {
  if (!raw) return [];
  return normalizeGlobs(raw.split(/\r?\n/));
}

// --- approvers ---------------------------------------------------------------

/**
 * Trim, lowercase, drop anything that cannot be a GitHub login pattern,
 * de-duplicate, cap.
 *
 * Lowercased on the way in because GitHub logins are case-insensitive and
 * `matchesAnyPattern` lowercases both sides anyway; storing the canonical form
 * means the settings page shows what actually gets compared. The charset allows
 * `*` and `?` for globs and `[` `]` for `dependabot[bot]`, matching the bypass
 * list's filter. It is a defence against junk, not a validator for GitHub's real
 * login rules.
 */
function normalizeApprovers(entries: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const login = entry.trim().toLowerCase().slice(0, MAX_ENTRY_LENGTH);
    if (login.length === 0) continue;
    if (!/^[a-z0-9*?\-[\]]+$/.test(login)) continue;
    if (seen.has(login)) continue;
    seen.add(login);
    out.push(login);
    if (out.length >= MAX_APPROVERS) break;
  }
  return out;
}

export function parseGuardApprovers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeApprovers(parsed);
  } catch {
    return [];
  }
}

export function serializeGuardApprovers(approvers: string[]): string {
  return JSON.stringify(normalizeApprovers(approvers));
}

/** Read the textarea on the settings page: one login per line. */
export function parseGuardApproversInput(raw: string | null): string[] {
  if (!raw) return [];
  return normalizeApprovers(raw.split(/\r?\n/));
}
