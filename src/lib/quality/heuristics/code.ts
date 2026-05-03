import type { Heuristic, PrFile } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const asStringList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string")
    ? (v as string[])
    : fallback;

const COMMENT_LINE_PATTERNS = [
  /^\s*\/\/.*/, // // line comment
  /^\s*#.*/, // # line comment (Python, sh, YAML)
  /^\s*--.*/, // -- (SQL, Lua)
  /^\s*\*.*/, // * inside /* ... */ block
  /^\s*\/\*.*/,
  /^\s*"""/, // python docstring
  /^\s*'''/,
];

function isCommentLine(text: string): boolean {
  return COMMENT_LINE_PATTERNS.some((re) => re.test(text));
}

function countAddedLines(file: PrFile): { code: number; comments: number } {
  if (!file.patch) return { code: 0, comments: 0 };
  let code = 0;
  let comments = 0;
  for (const line of file.patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1);
    if (text.trim().length === 0) continue;
    if (isCommentLine(text)) comments += 1;
    else code += 1;
  }
  return { code, comments };
}

function globMatch(path: string, glob: string): boolean {
  // Translate ** and * to regex; ? = single char.
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += ".";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i").test(path);
}

const DEFAULT_BLOCKED_PATHS = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/composer.lock",
  "dist/**",
  "build/**",
  "out/**",
  "**/*.min.js",
  "**/*.min.css",
];

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/i,
  /[-.]bundle\.js$/i,
  /\.lock$/i,
  /\.lockfile$/i,
  /^dist\//,
  /^build\//,
];

const TEST_PATTERNS = [
  /(^|\/)__tests__\//,
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /(^|\/)tests?\//,
  /_test\.go$/i,
  /\.spec\.rb$/i,
];

function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rb|rs|java|kt|cs|cpp|c|h|hpp|swift|m|php|scala)$/i;

export const codeHeuristics: Heuristic[] = [
  {
    id: "code.excessive_added_comments",
    group: "code",
    label: "Excessive added comments",
    description:
      "Ratio of added comment lines to added code lines is high — typical AI over-commenting.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: 10,
    thresholdKind: "number",
    run(ctx, threshold) {
      const absoluteMax = asNumber(threshold, 10);
      let code = 0;
      let comments = 0;
      for (const f of ctx.files) {
        const c = countAddedLines(f);
        code += c.code;
        comments += c.comments;
      }
      const ratio = code > 0 ? comments / code : comments > 0 ? Infinity : 0;
      const failed = comments > absoluteMax || ratio > 0.4;
      return {
        failed,
        value: comments,
        reason: failed
          ? `${comments} added comment lines (ratio ${ratio.toFixed(2)})`
          : undefined,
      };
    },
  },
  {
    id: "code.missing_final_newline",
    group: "code",
    label: "Missing final newline",
    description: "Any added file missing a trailing newline character.",
    weight: 1,
    defaultEnabled: true,
    run(ctx) {
      // The unified diff includes "\\ No newline at end of file" marker.
      const offending = ctx.files.filter((f) =>
        (f.patch ?? "").includes("\\ No newline at end of file")
      );
      return {
        failed: offending.length > 0,
        value: offending.length,
      };
    },
  },
  {
    id: "code.blocked_paths",
    group: "code",
    label: "Touches blocked paths",
    description:
      "PR modifies paths listed in the project's blocked-paths config (default: lockfiles, dist, build, minified files).",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: DEFAULT_BLOCKED_PATHS,
    thresholdKind: "stringList",
    run(ctx, threshold) {
      const globs = asStringList(threshold, DEFAULT_BLOCKED_PATHS);
      const hit = ctx.files.filter((f) =>
        globs.some((g) => globMatch(f.filename, g))
      );
      return {
        failed: hit.length > 0,
        value: hit.length,
        reason: hit.length > 0 ? hit[0]?.filename : undefined,
      };
    },
  },
  {
    id: "code.test_to_code_ratio",
    group: "code",
    label: "Code added without tests",
    description:
      "Adds source files but no test files are added or modified.",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const sourceAdded = ctx.files.some(
        (f) =>
          (f.status === "added" || f.status === "modified") &&
          !isTestPath(f.filename) &&
          SOURCE_EXTENSIONS.test(f.filename) &&
          (f.additions ?? 0) > 0
      );
      const anyTestTouched = ctx.files.some(
        (f) => isTestPath(f.filename) && (f.changes ?? 0) > 0
      );
      return {
        failed: sourceAdded && !anyTestTouched,
        value: anyTestTouched ? "tests" : "no-tests",
      };
    },
  },
  {
    id: "code.lockfile_only",
    group: "code",
    label: "Lockfile-only PR",
    description: "PR changes only lockfiles — almost always low-effort.",
    weight: 3,
    defaultEnabled: true,
    run(ctx) {
      if (ctx.files.length === 0) return { failed: false };
      const allLock = ctx.files.every((f) =>
        /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|poetry\.lock|composer\.lock)$/.test(
          f.filename
        )
      );
      return { failed: allLock, value: ctx.files.length };
    },
  },
  {
    id: "code.formatter_only",
    group: "code",
    label: "Formatter-only diff",
    description:
      "Diff appears to be exclusively reformatting (every hunk has equal token counts ignoring whitespace).",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      let saw = false;
      for (const f of ctx.files) {
        if (!f.patch) continue;
        // Pair up consecutive (-, +) lines; if their non-whitespace tokens
        // match exactly, it's likely formatting. Trip if all such pairs match
        // and there's at least 1 pair.
        const lines = f.patch.split("\n");
        let pairs = 0;
        let mismatched = 0;
        for (let i = 0; i < lines.length - 1; i++) {
          const a = lines[i];
          const b = lines[i + 1];
          if (a.startsWith("---") || a.startsWith("+++")) continue;
          if (a.startsWith("-") && b.startsWith("+")) {
            pairs += 1;
            const toks = (s: string) =>
              s.slice(1).replace(/\s+/g, " ").trim();
            if (toks(a) !== toks(b)) mismatched += 1;
          }
        }
        if (pairs > 0 && mismatched === 0) {
          saw = true;
          break;
        }
      }
      return { failed: saw };
    },
  },
  {
    id: "code.binary_or_generated",
    group: "code",
    label: "Binary or generated files added",
    description:
      "Adds binary files or files matching common generated patterns (*.min.js, *.lock, dist/**).",
    weight: 2,
    defaultEnabled: true,
    run(ctx) {
      const offending = ctx.files.filter(
        (f) =>
          f.status === "added" &&
          (GENERATED_PATTERNS.some((re) => re.test(f.filename)) ||
            // Heuristic for binary: GitHub returns no patch and additions=deletions=0 when changes>0.
            (!f.patch && (f.changes ?? 0) > 0))
      );
      return {
        failed: offending.length > 0,
        value: offending.length,
        reason: offending[0]?.filename,
      };
    },
  },
  {
    id: "code.docs_only_in_code_repo",
    group: "code",
    label: "Docs-only changes",
    description: "Only Markdown files changed.",
    weight: 1,
    defaultEnabled: true,
    run(ctx) {
      if (ctx.files.length === 0) return { failed: false };
      const allMd = ctx.files.every((f) => /\.(md|markdown|mdx)$/i.test(f.filename));
      return { failed: allMd, value: ctx.files.length };
    },
  },
];
