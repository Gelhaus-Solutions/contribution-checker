/**
 * What a PR in the batch actually is, read out of the PR itself.
 *
 * The manifest prints `#123 by @alice` and lets GitHub expand the title. That is
 * enough to say what shipped, and not nearly enough to verify it: a reviewer
 * picking up a batch needs to know what the change does and how to exercise it.
 *
 * Everything here is pure and derived from `PrSummary.body`, which
 * `reconcileStagingBatch` already holds. The list endpoint returns bodies
 * whether we read them or not, so the whole module costs no GitHub call.
 *
 * These are heuristics over prose, so they are wrong sometimes. That is
 * affordable in both directions: a missed QA section leaves the reviewer exactly
 * where they were before this existed, and a wrong one costs them a glance at
 * the PR. Nothing here gates anything.
 */

/** Longest QA instructions we store. Past this the reviewer should open the PR. */
const QA_STEPS_MAX = 2000;
/** Longest summary line we store. */
const SUMMARY_MAX = 400;
/** Guard against a body that links half the issue tracker. */
const MAX_LINKED_ISSUES = 10;

/**
 * Headings whose section is testing instructions. Matched case-insensitively on
 * the whole heading text, so "## Testing" hits and "## Testing philosophy"
 * does not: a section that merely mentions testing is prose, not steps.
 */
const QA_HEADINGS = [
  "qa",
  "qa steps",
  "qa notes",
  "testing",
  "test plan",
  "how to test",
  "how to verify",
  "verification",
  "steps to test",
  "steps to verify",
  "manual testing",
  "manual test plan",
];

/** `<!-- qa: ... -->` and `<!-- qa ... -->`, the explicit opt-in form. */
const QA_COMMENT_RE = /<!--\s*qa\s*:?\s*([\s\S]*?)-->/i;

/**
 * Closing keywords GitHub itself honours. Cross-repo forms (`owner/repo#12`)
 * are deliberately not captured: the board groups items by issue within one
 * repo, and a number from another repo would collide with a local one.
 */
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d{1,7})\b/gi;

/**
 * Lines a PR template supplies as guidance, which the author never wrote.
 *
 * These matter more than they look. A template that opens with
 * `eg: Bug fix, feature, docs update, ...` under its first heading makes that
 * the first "real" paragraph in every PR in the repo, so the board would show
 * the same meaningless sentence on every row and look broken. Saying nothing is
 * the better answer: it is at least true.
 */
const BOILERPLATE = [
  // Example markers: "eg:", "e.g.", "ex:", "i.e.".
  /^(?:eg|e\.g|ex|i\.e)[.:]/i,
  // Instruction voice. A description's opening paragraph almost never opens
  // this way unless a template wrote it.
  /^please\s/i,
  /^put an? ["']?x["']?\s/i,
  /^describe\s+(?:your|the)\s/i,
  /^explain\s+(?:why|what|how)\b/i,
  /^(?:list|link)\s+(?:any|the|related)\b/i,
];

function isBoilerplate(line: string): boolean {
  return BOILERPLATE.some((re) => re.test(line));
}

/** Strip fenced code blocks, so a `# heading` inside a diff sample is not one. */
function withoutFences(body: string): string {
  return body.replace(/^```[\s\S]*?^```/gm, "\n");
}

/**
 * Split a markdown body into `{ heading, content }` sections. Only ATX headings
 * (`#`..`######`) count; setext underlines are rare in PR templates and adding
 * them would make a line of dashes in a table start a section.
 */
function sections(body: string): Array<{ heading: string; content: string }> {
  const lines = withoutFences(body).split(/\r?\n/);
  const out: Array<{ heading: string; content: string }> = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (heading !== null) out.push({ heading, content: buf.join("\n").trim() });
    buf = [];
  };
  for (const line of lines) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim().toLowerCase().replace(/[:*_`]/g, "").trim();
      continue;
    }
    if (heading !== null) buf.push(line);
  }
  flush();
  return out;
}

function cap(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}...`;
}

/**
 * Is this section body actually empty? PR templates ship the heading with a
 * placeholder comment underneath, and storing that as "the QA steps" is worse
 * than storing nothing: it looks like the author wrote instructions.
 */
function isBlank(content: string): boolean {
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*[-*]\s*\[\s*\]\s*$/gm, "")
    .replace(/^[\s\-*_]+$/gm, "")
    .trim();
  if (stripped.length === 0) return true;
  // A lone "n/a" is the author declining to fill it in, not instructions.
  return /^(n\/?a|none|nothing|tbd|todo)\.?$/i.test(stripped);
}

/**
 * The author's own testing instructions, verbatim.
 *
 * The explicit `<!-- qa: -->` marker wins over a heading, because someone who
 * wrote the marker meant exactly that text, while a heading match is inference.
 */
export function extractQaSteps(body: string | null | undefined): string | null {
  if (!body) return null;

  const marked = QA_COMMENT_RE.exec(body);
  if (marked && !isBlank(marked[1])) return cap(marked[1], QA_STEPS_MAX);

  for (const section of sections(body)) {
    if (!QA_HEADINGS.includes(section.heading)) continue;
    if (isBlank(section.content)) continue;
    return cap(section.content, QA_STEPS_MAX);
  }
  return null;
}

/**
 * Issue numbers this PR closes. Deduplicated and sorted so the value is stable
 * across reconciles: an unstable order would rewrite the row, and eventually the
 * PR body, for no change.
 */
export function extractLinkedIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const found = new Set<number>();
  for (const m of withoutFences(body).matchAll(CLOSING_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b).slice(0, MAX_LINKED_ISSUES);
}

/**
 * One line saying what the change is: the first real paragraph of the body.
 *
 * "Real" is doing the work here. PR templates open with HTML comments, badges,
 * headings and checklists, none of which describe the change, so a naive "first
 * paragraph" reads back the template's own instructions on most repos.
 */
export function extractSummary(body: string | null | undefined): string | null {
  if (!body) return null;
  const cleaned = withoutFences(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/);

  const para: string[] = [];
  for (const raw of cleaned) {
    const line = raw.trim();
    if (line.length === 0) {
      if (para.length > 0) break;
      continue;
    }
    // Headings, checklists, list bullets, quotes, tables and horizontal rules
    // are all structure rather than description.
    if (/^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s|---+$|===+$)/.test(line)) {
      if (para.length > 0) break;
      continue;
    }
    if (/^!?\[[^\]]*\]\([^)]*\)\s*$/.test(line)) continue; // lone image or link
    // Template guidance is not a description. Skip it and keep looking, rather
    // than stopping, so a PR that fills in a later section is still summarized.
    if (isBoilerplate(line)) {
      if (para.length > 0) break;
      continue;
    }
    para.push(line);
  }
  if (para.length === 0) return null;

  const text = para
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .trim();
  return text.length === 0 ? null : cap(text, SUMMARY_MAX);
}
