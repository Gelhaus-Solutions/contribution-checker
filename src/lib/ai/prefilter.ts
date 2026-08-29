/**
 * Cheap, deterministic reasons not to call a model at all.
 *
 * Measured against the real provider, this is the only lever that saves money
 * here. Prompt caching does not fire on this deployment (identical back-to-back
 * calls report zero cached tokens even at four thousand input tokens, because a
 * BYOK key routes straight to the upstream provider), and there are no hidden
 * reasoning tokens to reclaim on the cheap tier. So the cost of a run is close
 * to fixed, and the only real saving is the run that never happens.
 *
 * Everything here is a pure function of text, with no network and no database,
 * so it runs before anything is claimed or fetched.
 */

/**
 * Lines a pull-request template supplies, which the author did not write.
 *
 * Deliberately similar in spirit to `BOILERPLATE` in src/lib/qa/extract.ts and
 * kept separate from it: that list decides whether a line can open a *summary*,
 * which is a narrower question than whether an author has said anything at all.
 * Merging them would make one of the two subtly wrong.
 */
const TEMPLATE_GUIDANCE = [
  /^(?:eg|e\.g|ex|i\.e)[.:]/i,
  /^please\s/i,
  /^put an? ["']?x["']?\s/i,
  /^describe\s+(?:your|the|what)\b/i,
  /^explain\s+(?:why|what|how)\b/i,
  /^(?:list|link|add|include|provide)\s+(?:any|the|a|related|your)\b/i,
  /^(?:what|why|how)\s+(?:does|did|is|are)\b.*\?$/i,
  /^delete\s+(?:this|these)\b/i,
  /^remove\s+(?:this|any)\b/i,
  /^check\s+(?:all|the)\s+that\s+apply/i,
  /^select\s+(?:one|all)\b/i,
  /^n\/?a$/i,
  /^tbd$/i,
  /^todo$/i,
  /^none$/i,
  /^-+$/,
];

/**
 * Does this pull-request body contain anything the author actually wrote?
 *
 * An unfilled template is structure only: headings, HTML comments, unticked
 * checkboxes, horizontal rules and instruction text. Strip those and a body that
 * nobody filled in has nothing left. That is the whole test.
 *
 * Structural rather than a comparison against the repo's template on purpose.
 * Fetching the template is an extra GitHub call per PR, it goes stale when the
 * template changes, and it answers nothing when the repo has no template but the
 * author pasted a skeleton from elsewhere. This costs nothing and covers all
 * three.
 *
 * Ticked checkboxes count as content: someone read the list and made a choice,
 * which is a signal even when they wrote no prose. Unticked ones do not.
 */
export function hasAuthoredContent(body: string | null | undefined): boolean {
  return authoredText(body).length > 0;
}

/**
 * The author's own words, with template scaffolding removed.
 *
 * Exported because a caller that has decided to make the call may as well send
 * the cleaned text: the guidance lines are tokens the model has to read and
 * would only mislead it about what the author said.
 */
export function authoredText(body: string | null | undefined): string {
  if (!body) return "";

  // Comments first, since they span lines and often wrap guidance prose.
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, "\n");

  const kept: string[] = [];
  let inFence = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      // A fenced block is content: nobody pastes a code sample by accident.
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }

    if (line.length === 0) continue;
    // Headings are structure. The template supplied them.
    if (/^#{1,6}\s/.test(line)) continue;
    // Horizontal rules.
    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(line)) continue;

    const checkbox = line.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (checkbox) {
      // Unticked: the template wrote it and the author ignored it.
      if (checkbox[1] === " ") continue;
      // Ticked: a deliberate act, so the label counts as content.
      const label = checkbox[2].trim();
      if (label.length > 0) kept.push(label);
      continue;
    }

    if (TEMPLATE_GUIDANCE.some((re) => re.test(line))) continue;

    kept.push(line);
  }

  return kept.join("\n").trim();
}
