/**
 * The task list inside a PR's `## QA` section, and how to tick one off.
 *
 * Authors write their QA steps as `- [ ] Verify X`, which makes the section a
 * working checklist rather than prose. This lets a reviewer tick those boxes
 * from the board and have the PR itself reflect it, so the two do not drift.
 *
 * GitHub stays the source of truth. There is no local per-step state: the
 * checkbox characters live in the PR body, `qaSteps` carries them verbatim, and
 * a reconcile re-derives them. That is what makes a box ticked on GitHub show
 * up here for free, and a failed write self-heal on the next pass rather than
 * leaving the two sides disagreeing forever.
 *
 * Everything here is pure. The rewrite in particular is surgical by design: it
 * changes exactly one character in the body and copies the rest through
 * untouched, because this is editing somebody else's prose and a regenerating
 * rewrite would eventually eat something a contributor wrote.
 */

/** A `- [ ]` / `- [x]` line inside the QA section. */
export type QaTask = {
  /** Position among the task lines of that section, which is how the UI and
   * the writer agree on which box is meant. */
  index: number;
  text: string;
  checked: boolean;
};

/** Matches one task-list line, capturing the parts around the state character. */
const TASK_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s?)(.*)$/;

/** Same heading set `extractQaSteps` accepts, so what is rendered is what is
 * writable. Kept in sync deliberately: a section the reader can see but the
 * writer cannot find would produce a checkbox that silently does nothing. */
const QA_HEADINGS = new Set([
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
]);

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*```/;

/**
 * Blank out fenced code so a `- [ ]` in a sample is not tickable, while keeping
 * the array index-aligned with the real body. `extractQaSteps` collapses fences
 * instead, which is fine there and useless here: line numbers have to survive.
 */
function maskFences(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out;
}

/** The content lines of the QA section, as a half-open line range. */
export function findQaSpan(
  lines: string[],
): { start: number; end: number } | null {
  const masked = maskFences(lines);
  let start: number | null = null;
  for (let i = 0; i < masked.length; i += 1) {
    const m = HEADING_RE.exec(masked[i]);
    if (!m) continue;
    const heading = m[1].trim().toLowerCase().replace(/[:*_`]/g, "").trim();
    if (start !== null) return { start, end: i };
    if (QA_HEADINGS.has(heading)) start = i + 1;
  }
  return start === null ? null : { start, end: masked.length };
}

/** The tasks in a body's QA section, in the order they appear. */
export function parseTasks(body: string | null | undefined): QaTask[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const span = findQaSpan(lines);
  if (!span) return [];
  const masked = maskFences(lines);

  const out: QaTask[] = [];
  for (let i = span.start; i < span.end; i += 1) {
    const m = TASK_RE.exec(masked[i]);
    if (!m) continue;
    out.push({
      index: out.length,
      text: m[4].trim(),
      checked: m[2].toLowerCase() === "x",
    });
  }
  return out;
}

export function taskProgress(tasks: QaTask[]): { done: number; total: number } {
  return { done: tasks.filter((t) => t.checked).length, total: tasks.length };
}

export type ToggleResult =
  | { ok: true; body: string }
  | { ok: false; reason: "no_section" | "not_found" | "text_moved" | "unchanged" };

/**
 * Flip one checkbox in a PR body.
 *
 * `expectedText` is the guard that makes this safe to run against a body that
 * may have changed since the board rendered it. Somebody editing the PR can
 * insert, delete or reorder steps, and an index alone would then tick the wrong
 * one. When the text at that index does not match, the whole toggle is refused
 * rather than applied to whatever happens to be there now, and the caller tells
 * the reviewer to reload.
 */
export function toggleTaskInBody(args: {
  body: string;
  index: number;
  expectedText: string;
  checked: boolean;
}): ToggleResult {
  // Preserve the body's own line endings: rejoining CRLF content with LF would
  // rewrite every line of the description as a diff.
  const crlf = args.body.includes("\r\n");
  const lines = args.body.split(/\r?\n/);
  const span = findQaSpan(lines);
  if (!span) return { ok: false, reason: "no_section" };
  const masked = maskFences(lines);

  let seen = -1;
  for (let i = span.start; i < span.end; i += 1) {
    const m = TASK_RE.exec(masked[i]);
    if (!m) continue;
    seen += 1;
    if (seen !== args.index) continue;

    if (m[4].trim() !== args.expectedText.trim()) {
      return { ok: false, reason: "text_moved" };
    }
    if ((m[2].toLowerCase() === "x") === args.checked) {
      return { ok: false, reason: "unchanged" };
    }
    // Rebuilt from the captured pieces, so indentation, bullet character and
    // the text after the box all survive exactly as the author wrote them.
    lines[i] = `${m[1]}${args.checked ? "x" : " "}${m[3]}${m[4]}`;
    return { ok: true, body: lines.join(crlf ? "\r\n" : "\n") };
  }
  return { ok: false, reason: "not_found" };
}
