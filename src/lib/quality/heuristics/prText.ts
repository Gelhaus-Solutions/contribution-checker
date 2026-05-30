import type { Heuristic } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

// Range-based emoji detection avoids carrying a giant table. Includes the
// common emoji blocks plus emoji presentation selector (FE0F).
export const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}]/gu;

export const VAGUE_TITLE_RE =
  /^(update|fix|wip|patch|changes?|misc|stuff|chore)$/i;

// GitHub's web-UI default titles when the user clicks the pencil-edit icon
// and doesn't change the title (e.g. "Update README.md", "Create foo.ts").
export const GITHUB_DEFAULT_TITLE_RE =
  /^(update|create|delete|rename|add)\s+\S+$/i;

export function isTitleVague(title: string): boolean {
  const trimmed = (title ?? "").trim();
  const stripped = trimmed.replace(EMOJI_RE, "").trim();
  const isEmojiOnly = trimmed.length > 0 && stripped.length === 0;
  return (
    trimmed.length === 0 ||
    trimmed.length < 8 ||
    VAGUE_TITLE_RE.test(trimmed) ||
    GITHUB_DEFAULT_TITLE_RE.test(trimmed) ||
    isEmojiOnly
  );
}

const AI_WATERMARK_RE =
  /\b(as an ai|i (?:am|'m) an ai|i cannot directly|i'?ve updated the code|here(?:'s| is) the updated|certainly[!.,]|of course[!.,]|let me (?:know if|help)|language model|i hope this helps|sure[!.,] (?:here|i)|generated (?:with|by) (?:claude code|claude|openai codex|codex|chatgpt|copilot|github copilot|gemini|pr agent|cursor|devin|aider|cline))\b/i;

const ISSUE_REF_RE = /(?:#\d+|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+)/i;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Extract the structural pieces of a PR template (headings and checklist
 * items) separately, so heuristics can reason about each. HTML comments
 * (typical "delete this" instruction blocks) are stripped first.
 */
export type TemplateStructure = {
  /** Markdown heading text (any level), lowercased and trimmed, deduped. */
  headings: string[];
  /** Checkbox label text (`- [ ] X`, `* [x] X`), lowercased, deduped. */
  checkboxes: string[];
};

export function extractTemplateStructure(template: string): TemplateStructure {
  const cleaned = template.replace(HTML_COMMENT_RE, "");
  const headings = new Set<string>();
  const checkboxes = new Set<string>();
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+\S/.test(line)) {
      headings.add(line.replace(/^#{1,6}\s+/, "").toLowerCase());
      continue;
    }
    const checkbox = /^[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (checkbox) {
      const text = checkbox[1].trim();
      if (text.length >= 4) checkboxes.add(text.toLowerCase());
    }
  }
  return {
    headings: Array.from(headings),
    checkboxes: Array.from(checkboxes),
  };
}

/**
 * Tokenize for fuzzy matching: strip markdown link syntax to plain text,
 * drop punctuation, collapse whitespace, lowercase, and split into words of
 * length >= 2. Stop-words and parenthetical asides are kept; what matters
 * is the proportion of the template's words that survive into the body.
 */
function fuzzyTokens(s: string): string[] {
  const noLinks = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const lowered = noLinks.toLowerCase();
  const words = lowered
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return words;
}

/**
 * Returns the percentage of the template label's tokens that also appear in
 * the body's tokens (0–100). 100 means every word of the template label is
 * present somewhere in the body; lower means progressively more words missing.
 * Empty templates return 100 (vacuously matched).
 */
export function templateLabelMatchPct(label: string, body: string): number {
  const want = fuzzyTokens(label);
  if (want.length === 0) return 100;
  const have = new Set(fuzzyTokens(body));
  let hits = 0;
  for (const w of want) if (have.has(w)) hits += 1;
  return Math.round((hits / want.length) * 100);
}

/** Extract markdown headings (any level) from the body, lowercased. */
export function extractBodyHeadings(body: string): string[] {
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^#{1,6}\s+(\S.*)$/.exec(line);
    if (m) out.push(m[1].trim().toLowerCase());
  }
  return out;
}

export const prTextHeuristics: Heuristic[] = [
  {
    id: "pr.body_empty",
    group: "pr",
    label: "Empty PR body",
    description: "Body is missing or whitespace-only.",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const body = (ctx.pr.body ?? "").trim();
      return { failed: body.length === 0, value: body.length };
    },
  },
  {
    id: "pr.body_too_long",
    group: "pr",
    label: "Wall-of-text PR body",
    description: "Body exceeds the configured character limit.",
    weight: 1,
    defaultEnabled: true,
    defaultThreshold: 2500,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 2500);
      const len = (ctx.pr.body ?? "").length;
      return {
        failed: len > max,
        value: len,
        reason: len > max ? `${len} chars (>${max})` : undefined,
      };
    },
  },
  {
    id: "pr.body_emoji_count",
    group: "pr",
    label: "Excessive emojis in body",
    description: "Many AI-generated PRs are decorated with emojis.",
    weight: 1,
    defaultEnabled: true,
    defaultThreshold: 2,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 2);
      const matches = (ctx.pr.body ?? "").match(EMOJI_RE) ?? [];
      return {
        failed: matches.length > max,
        value: matches.length,
        reason:
          matches.length > max ? `${matches.length} emojis (>${max})` : undefined,
      };
    },
  },
  {
    id: "pr.body_inline_code_refs",
    group: "pr",
    label: "Excessive inline code references",
    description: "Walls of inline ` ` references often indicate AI summaries.",
    weight: 1,
    defaultEnabled: true,
    defaultThreshold: 5,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 5);
      const body = ctx.pr.body ?? "";
      // Count single-backtick spans only (skip ``` fenced blocks).
      const stripped = body.replace(/```[\s\S]*?```/g, "");
      const inline = stripped.match(/`[^`\n]+`/g) ?? [];
      const failed = inline.length > max;
      return {
        failed,
        value: inline.length,
        reason: failed ? `${inline.length} inline refs (>${max})` : undefined,
        penaltyPoints: failed ? inline.length - max : 0,
      };
    },
  },
  {
    id: "pr.title_vague",
    group: "pr",
    label: "Vague PR title",
    description:
      'Title is a single vague word (update / fix / wip / patch / changes / misc / stuff / chore), GitHub\'s web-UI default ("Update README.md"), under 8 chars, or emoji-only.',
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const title = (ctx.pr.title ?? "").trim();
      return { failed: isTitleVague(title), value: title };
    },
  },
  {
    id: "pr.no_linked_issue",
    group: "pr",
    label: "No linked issue",
    description: "Body has no #N reference or fixes/closes/resolves keyword.",
    weight: 1,
    defaultEnabled: false,
    run(ctx) {
      const body = ctx.pr.body ?? "";
      return { failed: !ISSUE_REF_RE.test(body) };
    },
  },
  {
    id: "pr.honeypot_hit",
    group: "pr",
    label: "Honeypot keyword hit",
    description:
      "PR body contains hidden honeypot text from the project's PR template, typically copy-pasted by AI bots.",
    weight: 4,
    defaultEnabled: true,
    run(ctx) {
      const body = (ctx.pr.body ?? "").toLowerCase();
      const honeypots = ctx.project.prTemplateHoneypots
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const hit = honeypots.find((h) => body.includes(h));
      return { failed: Boolean(hit), value: hit ?? null };
    },
  },
  {
    id: "pr.uses_template",
    group: "pr",
    label: "PR doesn't use the repo's PR template",
    description:
      "Repo ships a PR template (e.g. .github/PULL_REQUEST_TEMPLATE.md). When the template has checklist items, the body must include them. Threshold sets how many checkboxes may be missing (default 0). Match strictness is set project-wide (Quality core settings, default 80%). When the template has no checkboxes, at least one heading must appear. Skipped when the repo has no template.",
    weight: 4,
    defaultEnabled: true,
    defaultThreshold: 0,
    thresholdKind: "number",
    run(ctx, threshold) {
      const template = (ctx.prTemplate ?? "").trim();
      if (template.length === 0) return { failed: false, reason: "No template in repo" };
      const { headings, checkboxes } = extractTemplateStructure(template);
      if (headings.length === 0 && checkboxes.length === 0) {
        return { failed: false, reason: "Template has no distinctive markers" };
      }
      const body = ctx.pr.body ?? "";
      const bodyLower = body.toLowerCase();
      if (body.trim().length === 0) {
        return {
          failed: true,
          value: `0/${checkboxes.length || headings.length}`,
          reason: "Empty body: template not used",
        };
      }
      const matchPct = Math.max(0, Math.min(100, ctx.project.templateMatchPct));
      if (checkboxes.length > 0) {
        const allowedMissing = asNumber(threshold, 0);
        const missing = checkboxes.filter((c) => {
          if (matchPct >= 100) return !bodyLower.includes(c);
          return templateLabelMatchPct(c, body) < matchPct;
        });
        const present = checkboxes.length - missing.length;
        const failed = missing.length > allowedMissing;
        return {
          failed,
          value: `${present}/${checkboxes.length} checkboxes`,
          reason: failed
            ? `${missing.length} required checkbox item${missing.length === 1 ? "" : "s"} missing (max ${allowedMissing}, match ≥${matchPct}%)`
            : undefined,
        };
      }
      const matched = headings.filter((h) => {
        if (matchPct >= 100) return bodyLower.includes(h);
        return templateLabelMatchPct(h, body) >= matchPct;
      });
      return {
        failed: matched.length === 0,
        value: `${matched.length}/${headings.length} headings`,
        reason: matched.length === 0 ? "No template headings in body" : undefined,
      };
    },
  },
  {
    id: "pr.template_extra_headers",
    group: "pr",
    label: "Body adds too many extra headers beyond the template",
    description:
      "Counts headers in the body whose text doesn't appear in the repo's PR template. Threshold is the maximum number of extra headers admins allow (default 0). Skipped when the repo has no template.",
    weight: 3,
    defaultEnabled: true,
    defaultThreshold: 0,
    thresholdKind: "number",
    run(ctx, threshold) {
      const template = (ctx.prTemplate ?? "").trim();
      if (template.length === 0) return { failed: false, reason: "No template in repo" };
      const { headings } = extractTemplateStructure(template);
      if (headings.length === 0) {
        return { failed: false, reason: "Template has no headings" };
      }
      const max = asNumber(threshold, 0);
      const allowed = new Set(headings);
      const bodyHeadings = extractBodyHeadings(ctx.pr.body ?? "");
      let extra = 0;
      for (const h of bodyHeadings) {
        if (!allowed.has(h)) extra += 1;
      }
      const failed = extra > max;
      return {
        failed,
        value: extra,
        reason: failed
          ? `${extra} extra header${extra === 1 ? "" : "s"} (>${max})`
          : undefined,
        penaltyPoints: failed ? extra - max : 0,
      };
    },
  },
  {
    id: "pr.ai_watermark",
    group: "pr",
    label: "AI watermark phrase",
    description:
      'Body contains a phrase commonly emitted by language models (e.g. "as an AI", "Here is the updated").',
    weight: 4,
    defaultEnabled: true,
    run(ctx) {
      const body = ctx.pr.body ?? "";
      // Strip markdown link syntax so footers like
      //   🤖 Generated with [Claude Code](https://claude.com/claude-code)
      // collapse to "Generated with Claude Code" before matching.
      const stripped = body.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      const m = stripped.match(AI_WATERMARK_RE);
      return {
        failed: Boolean(m),
        value: m?.[0] ?? null,
        reason: m ? `Matched: "${m[0]}"` : undefined,
      };
    },
  },
];
