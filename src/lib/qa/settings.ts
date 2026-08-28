/**
 * Project-level QA configuration that lives in a JSON column.
 *
 * Parsed here rather than with a bare `JSON.parse` at the call site, per the
 * house rule for JSON columns: the column is a string that a migration, a hand
 * edit or an older version could have left in any shape, and a settings page
 * that throws is a settings page nobody can use to fix the value.
 */

/** Standing checks a reviewer would not thank us for scrolling past. */
const MAX_STANDING_CHECKS = 40;
const MAX_LABEL_LENGTH = 120;

/**
 * The project's own smoke tests, regenerated into every batch as CHECK items.
 *
 * Anything unparseable reads as "none", which is the safe direction: a batch
 * with no standing checks is just a batch of PRs, while inventing checks from
 * corrupt data would block releases on items nobody wrote.
 */
export function parseStandingChecks(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalize(parsed);
  } catch {
    return [];
  }
}

/** Trim, drop blanks, de-duplicate, cap. */
function normalize(entries: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const label = entry.trim().slice(0, MAX_LABEL_LENGTH);
    if (label.length === 0) continue;
    // Duplicates would collide on the item key and silently drop one anyway,
    // so they are removed here, where the settings page shows the result.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_STANDING_CHECKS) break;
  }
  return out;
}

/** Normalize and store. Shares `normalize` with the parser so a value written
 * here always reads back identically, which is what keeps a no-op save from
 * looking like a change in the audit log. */
export function serializeStandingChecks(checks: string[]): string {
  return JSON.stringify(normalize(checks));
}

/** Read the textarea on the settings page: one check per line. */
export function parseStandingChecksInput(raw: string | null): string[] {
  if (!raw) return [];
  return normalize(raw.split(/\r?\n/));
}

/**
 * Stable slug for a standing check, used as the item key so a verdict survives
 * every reconcile.
 *
 * Derived from the text, which means renaming a check retires the old item and
 * starts a fresh one. That is the honest behaviour: an edited check is a
 * different question, and carrying the old "passed" onto it would claim someone
 * verified something they never read. The index is included so two checks that
 * slug identically (punctuation-only differences) stay distinct.
 */
export function standingCheckKey(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `standing:${index}:${slug || "check"}`;
}
