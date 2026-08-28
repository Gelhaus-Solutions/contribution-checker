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

/**
 * The tasks in a block of text that is *already* just the QA section.
 *
 * This is what the board uses, because `StagingBatchItem.qaSteps` stores the
 * section's content with the heading stripped off. Handing that to the
 * body-scoped parser below finds no heading, returns nothing, and silently
 * degrades the checklist to read-only text, which is exactly the bug this
 * split exists to prevent.
 */
export function parseTaskLines(block: string | null | undefined): QaTask[] {
  if (!block) return [];
  const masked = maskFences(block.split(/\r?\n/));
  const out: QaTask[] = [];
  for (const line of masked) {
    const m = TASK_RE.exec(line);
    if (!m) continue;
    out.push({
      index: out.length,
      text: m[4].trim(),
      checked: m[2].toLowerCase() === "x",
    });
  }
  return out;
}

/**
 * The tasks in a full PR body's QA section, scoped to that section so the
 * contributor checklist underneath is never included.
 */
export function parseTasksInBody(body: string | null | undefined): QaTask[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const span = findQaSpan(lines);
  if (!span) return [];
  return parseTaskLines(
    maskFences(lines).slice(span.start, span.end).join("\n"),
  );
}

export function taskProgress(tasks: QaTask[]): { done: number; total: number } {
  return { done: tasks.filter((t) => t.checked).length, total: tasks.length };
}

/** One box the reviewer moved. */
export type TaskChange = {
  index: number;
  /** The step text as the board rendered it, so a description edited in the
   * meantime is detected rather than ticking whatever slid into that slot. */
  expectedText: string;
  checked: boolean;
};

export type ApplyResult =
  | { ok: true; body: string; applied: number }
  | { ok: false; reason: "no_section" | "not_found" | "text_moved" };

/**
 * Apply a batch of checkbox changes to a PR body in one pass.
 *
 * Batched rather than one call per click because the board holds the ticks
 * locally and flushes them together: a reviewer working through five steps
 * should cost the PR one edit in its timeline, not five.
 *
 * All-or-nothing on the guard. If any step's text has moved, the whole batch is
 * refused rather than half-applied, because a partially-written checklist is
 * worse than an unwritten one: the reviewer cannot tell which half landed.
 * Changes that are already in the desired state are skipped, not refused, so
 * two people ticking the same box is not an error.
 */
export function applyTaskChanges(args: {
  body: string;
  changes: TaskChange[];
}): ApplyResult {
  // Preserve the body's own line endings: rejoining CRLF content with LF would
  // rewrite every line of the description as a diff.
  const crlf = args.body.includes("\r\n");
  const lines = args.body.split(/\r?\n/);
  const span = findQaSpan(lines);
  if (!span) return { ok: false, reason: "no_section" };
  const masked = maskFences(lines);

  // Task index -> line number, computed once so the batch cannot renumber
  // itself as it edits.
  const lineFor: number[] = [];
  for (let i = span.start; i < span.end; i += 1) {
    if (TASK_RE.test(masked[i])) lineFor.push(i);
  }

  let applied = 0;
  for (const change of args.changes) {
    const line = lineFor[change.index];
    if (line === undefined) return { ok: false, reason: "not_found" };
    const m = TASK_RE.exec(lines[line]);
    if (!m) return { ok: false, reason: "not_found" };
    if (m[4].trim() !== change.expectedText.trim()) {
      return { ok: false, reason: "text_moved" };
    }
    if ((m[2].toLowerCase() === "x") === change.checked) continue;
    // Rebuilt from the captured pieces, so indentation, bullet character and
    // the text after the box all survive exactly as the author wrote them.
    lines[line] = `${m[1]}${change.checked ? "x" : " "}${m[3]}${m[4]}`;
    applied += 1;
  }

  return { ok: true, body: lines.join(crlf ? "\r\n" : "\n"), applied };
}
