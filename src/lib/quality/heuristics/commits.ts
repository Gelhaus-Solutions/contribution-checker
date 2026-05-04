import type { Heuristic } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const asStringList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string")
    ? (v as string[])
    : fallback;

const CONV_COMMITS_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?:\s.+/;

export const commitHeuristics: Heuristic[] = [
  {
    id: "commit.message_too_long",
    group: "commit",
    label: "Commit message too long",
    description: "Any single commit message exceeds the configured length.",
    weight: 1,
    defaultEnabled: true,
    defaultThreshold: 500,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 500);
      const longest = ctx.commits.reduce(
        (m, c) => Math.max(m, (c.message ?? "").length),
        0
      );
      return {
        failed: longest > max,
        value: longest,
        reason: longest > max ? `Longest: ${longest} chars` : undefined,
      };
    },
  },
  {
    id: "commit.author_mismatch",
    group: "commit",
    label: "Author mismatch across commits",
    description:
      "Commits authored by multiple identities — usually cherry-picked work. Threshold is an allowlist of author emails or logins (one per line) that don't count toward the distinct-author tally — e.g. bot accounts like dependabot[bot] or noreply@github.com.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: [],
    thresholdKind: "stringList",
    run(ctx, threshold) {
      const allow = new Set(
        asStringList(threshold, [])
          .map((s) => s.toLowerCase().trim())
          .filter(Boolean)
      );
      const authors = new Set(
        ctx.commits
          .filter((c) => {
            const email = c.authorEmail?.toLowerCase();
            const login = c.authorLogin?.toLowerCase();
            if (email && allow.has(email)) return false;
            if (login && allow.has(login)) return false;
            return true;
          })
          .map((c) => c.authorEmail?.toLowerCase() ?? c.authorLogin?.toLowerCase())
          .filter(Boolean) as string[]
      );
      return {
        failed: authors.size > 1,
        value: authors.size,
        reason: authors.size > 1 ? `${authors.size} distinct authors` : undefined,
      };
    },
  },
  {
    id: "commit.conv_commits",
    group: "commit",
    label: "Conventional Commits format",
    description:
      "Each commit message must match `type(scope): subject`. Off by default.",
    weight: 1,
    defaultEnabled: false,
    run(ctx) {
      const violators = ctx.commits.filter(
        (c) => !CONV_COMMITS_RE.test((c.message ?? "").split("\n")[0] ?? "")
      );
      return {
        failed: violators.length > 0,
        value: violators.length,
        reason: violators.length > 0 ? `${violators.length} non-conv commits` : undefined,
        penaltyPoints: violators.length * 5,
      };
    },
  },
  {
    id: "commit.whitespace_only",
    group: "commit",
    label: "Whitespace-only commits",
    description:
      "At least one commit changes only whitespace (heuristic: tiny diffs only modify ws characters in the patch).",
    weight: 1,
    defaultEnabled: true,
    run(ctx) {
      // We don't have per-commit diffs from listFiles; use the aggregate
      // patch text. If every hunk-line in the entire PR is whitespace-only,
      // treat it as whitespace-only PR.
      let anyMeaningful = false;
      for (const f of ctx.files) {
        if (!f.patch) continue;
        for (const line of f.patch.split("\n")) {
          if (!line.startsWith("+") && !line.startsWith("-")) continue;
          if (line.startsWith("+++") || line.startsWith("---")) continue;
          if (line.slice(1).trim().length > 0) {
            anyMeaningful = true;
            break;
          }
        }
        if (anyMeaningful) break;
      }
      return { failed: !anyMeaningful && ctx.files.length > 0 };
    },
  },
  {
    id: "commit.single_giant",
    group: "commit",
    label: "Single giant commit",
    description: "One commit with very many changes — typical AI bulk diff.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: 2000,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 2000);
      const lines = ctx.files.reduce(
        (acc, f) => acc + (f.additions ?? 0) + (f.deletions ?? 0),
        0
      );
      return {
        failed: ctx.commits.length === 1 && lines > max,
        value: lines,
      };
    },
  },
];
