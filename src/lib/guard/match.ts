/**
 * Which of a PR's changed files are guarded, and whether an unlock still covers
 * them.
 *
 * Pure. The caller supplies the file list; nothing here reaches GitHub.
 */

import { minimatch } from "minimatch";
import { GUARD_RULES, type GuardRuleId } from "@/lib/guard/rules";
import type { ResolvedGuardConfig } from "@/lib/guard/config";

/** One changed file, reduced to what the guard reads. */
export type GuardFile = {
  filename: string;
  /** Blob SHA at the PR head. Identifies the *content*, which is what an
   * approval is actually about. */
  sha: string;
  status: string;
};

export type GuardHit = {
  path: string;
  sha: string;
  /** The catalog rule that matched, or null when a custom glob did. */
  ruleId: GuardRuleId | null;
  /** The rule's label, or the glob itself: what to show a reviewer. */
  reason: string;
};

/**
 * Classify the diff.
 *
 * A file is reported once, by the first rule that claims it, so a migration
 * caught by both the `migrations` rule and a project's own `prisma/**` glob
 * appears one time. Catalog rules are tried before globs because their labels
 * read better than a pattern.
 *
 * Deleted files count. Removing a migration is a change to migrations, and
 * deleting a workflow is exactly the edit a guard exists to catch.
 *
 * Renames are matched on the *new* path only: `listPullRequestFiles` reports the
 * destination as `filename`, and a file renamed *into* a guarded directory is
 * guarded while one renamed out of it no longer is.
 */
export function matchGuardedFiles(
  files: GuardFile[],
  cfg: ResolvedGuardConfig,
): GuardHit[] {
  const hits: GuardHit[] = [];
  for (const file of files) {
    const path = file.filename;
    const rule = GUARD_RULES.find(
      (r) => cfg.rules.has(r.id) && r.matches(path),
    );
    if (rule) {
      hits.push({ path, sha: file.sha, ruleId: rule.id, reason: rule.label });
      continue;
    }
    const glob = cfg.globs.find((g) => matchesGlob(path, g));
    if (glob) {
      hits.push({ path, sha: file.sha, ruleId: null, reason: glob });
    }
  }
  // Sorted so the check summary, the comment and the stored snapshot are all
  // deterministic: the comment is diffed before it is written, and an unstable
  // order would edit it on every event.
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `dot: true` because the paths that most want guarding start with a dot
 * (`.github/workflows/`, `.env`), and a glob list where `*` silently skips them
 * is a guard with a hole in it that nobody can see.
 *
 * A bare directory name is treated as "everything under it", so `prisma` and
 * `prisma/` both mean `prisma/**`. Writing the recursive form is what people
 * forget, and a glob that matches nothing is a guard that is not there.
 */
function matchesGlob(path: string, glob: string): boolean {
  const pattern = glob.endsWith("/") ? `${glob}**` : glob;
  if (minimatch(path, pattern, { dot: true })) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return minimatch(path, `${pattern}/**`, { dot: true });
  }
  return false;
}

/** The stored snapshot: guarded path -> the blob SHA that was signed off. */
export type GuardApprovedFiles = Record<string, string>;

/**
 * Read `PrCheck.guardApprovedFiles`.
 *
 * Permissive-closed: anything unreadable means nothing is approved, so the
 * check falls back to asking for the approval again. The opposite mistake would
 * let corrupt JSON pass a migration nobody looked at.
 */
export function parseApprovedFiles(
  raw: string | null | undefined,
): GuardApprovedFiles {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: GuardApprovedFiles = {};
    for (const [path, sha] of Object.entries(parsed)) {
      if (typeof path === "string" && typeof sha === "string") out[path] = sha;
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize the hits as approved. Keys in sorted order so a re-approval of the
 * same diff writes a byte-identical column. */
export function serializeApprovedFiles(hits: GuardHit[]): string {
  const out: GuardApprovedFiles = {};
  for (const hit of [...hits].sort((a, b) => a.path.localeCompare(b.path))) {
    out[hit.path] = hit.sha;
  }
  return JSON.stringify(out);
}

/**
 * Does an existing sign-off still cover this diff?
 *
 * Every currently-guarded file must appear in the snapshot with the *same* blob
 * SHA. That is what makes "re-require approval only when guarded files changed"
 * exact in both directions: a push touching only ordinary files leaves every
 * guarded blob where it was and keeps the unlock, while editing a guarded file
 * by one character changes its blob and takes the unlock away.
 *
 * A rebase that leaves content identical produces the same blob SHA, so it does
 * not re-block. Files approved earlier and no longer in the diff are ignored:
 * the question is whether everything present was signed off, not whether the
 * diff is unchanged.
 */
export function unlockCovers(
  hits: GuardHit[],
  approved: GuardApprovedFiles,
): boolean {
  return hits.every((hit) => approved[hit.path] === hit.sha);
}
