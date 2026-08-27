/**
 * What a staging batch actually ships, beyond the list of PR numbers.
 *
 * The manifest answers "which PRs are in this release". It does not answer the
 * question a reviewer of a staging -> production PR actually has to ask before
 * merging: *is anything about to break if I just click merge?* New environment
 * variables are the sharp edge (the deploy comes up and immediately fails on a
 * missing secret), and database migrations, dependency bumps, CI changes and
 * infrastructure edits are the rest of it.
 *
 * All of this is derived from the `default...staging` compare the reconcile
 * already fetches, so the digest costs no extra GitHub call: the compare
 * response carries the file list and patches whether we read them or not.
 *
 * Everything here is pure and heuristic. It is a "look at this" list, never a
 * gate: a false positive costs a reviewer two seconds, and a miss leaves them
 * exactly where they were before this existed.
 *
 * Which parts of it get printed is per-project configuration, resolved through
 * `resolveStagingConfig` and applied at render time: the digest is always built
 * in full (it is in-memory work over a response we already hold) and
 * `renderDigestLines` prints only the enabled sections. `DIGEST_SECTIONS` is
 * the catalog the settings UI renders from, the same way `ALL_HEURISTICS` is
 * for quality scoring: add a section there and the checkbox appears with no
 * further UI work and no migration.
 */

/** One file in a compare, as GitHub reports it. */
export type CompareFile = {
  filename: string;
  /** Set only for renames. */
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff, absent for binaries and for very large files. */
  patch: string | null;
};

/** One commit in a compare, reduced to what the digest reads. */
export type CompareCommit = {
  sha: string;
  message: string;
};

/**
 * Every section of the digest, in the order it renders. The settings UI lists
 * these; a project stores the subset it wants in `Project.stagingDigestSections`.
 *
 * Six of the ids double as file-group ids in `GROUPS` below, which is what
 * makes a group's checkbox work with no extra wiring.
 */
export const DIGEST_SECTIONS = [
  {
    id: "overview",
    label: "Batch overview",
    hint: "How many PRs, who wrote them, and how long the batch has been open.",
  },
  {
    id: "env",
    label: "Environment variables",
    hint: "Variables the batch starts or stops referencing. The one that breaks a deploy.",
  },
  {
    id: "breaking",
    label: "Breaking-change commits",
    hint: "Commits marked `type!:` or carrying a BREAKING CHANGE trailer.",
  },
  {
    id: "migrations",
    label: "Database migrations",
    hint: "Migration files the batch adds, which have to run against production.",
  },
  {
    id: "schema",
    label: "Database schema",
    hint: "Schema definitions the batch edits.",
  },
  {
    id: "dependencies",
    label: "Dependencies",
    hint: "Package manifests and lockfiles.",
  },
  {
    id: "workflows",
    label: "CI workflows",
    hint: "Workflow and pipeline definitions.",
  },
  {
    id: "infra",
    label: "Infrastructure and deploy config",
    hint: "Dockerfiles, compose files, Terraform, Helm, platform config.",
  },
  {
    id: "tooling",
    label: "Build and tooling config",
    hint: "Build, bundler, linter, formatter and test-runner config.",
  },
  {
    id: "stats",
    label: "Diff stats footer",
    hint: "Files changed, lines added and removed, commit count.",
  },
] as const;

export type DigestSectionId = (typeof DIGEST_SECTIONS)[number]["id"];

export const ALL_DIGEST_SECTION_IDS: DigestSectionId[] = DIGEST_SECTIONS.map(
  (s) => s.id,
);

const KNOWN_SECTIONS = new Set<string>(ALL_DIGEST_SECTION_IDS);

/**
 * Parse `Project.stagingDigestSections` into the set of sections to print.
 *
 * Unreadable or missing config falls back to *everything*, not to nothing: the
 * digest as a whole is already behind its own switch, so a project that has
 * turned it on has asked to see something, and a JSON column that failed to
 * parse must not silently blank the release PR. Unknown ids are dropped, which
 * is what lets a section be removed from the catalog without a data migration.
 */
export function parseDigestSections(
  raw: string | null | undefined,
): Set<DigestSectionId> {
  if (!raw) return new Set(ALL_DIGEST_SECTION_IDS);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed.filter((id): id is DigestSectionId =>
          typeof id === "string" ? KNOWN_SECTIONS.has(id) : false,
        ),
      );
    }
  } catch {
    // fall through to the permissive default
  }
  return new Set(ALL_DIGEST_SECTION_IDS);
}

/** Serialize for the column, in catalog order so the stored value is stable. */
export function serializeDigestSections(
  ids: Iterable<DigestSectionId>,
): string {
  const wanted = new Set<string>([...ids]);
  return JSON.stringify(ALL_DIGEST_SECTION_IDS.filter((id) => wanted.has(id)));
}

/** An environment variable the batch introduces or drops. */
export type EnvVarMention = {
  name: string;
  /** The file it was seen in, for "where did this come from". */
  source: string;
};

/** A named class of file the batch touched. */
export type DigestGroup = {
  id: DigestSectionId;
  label: string;
  /** Up to `MAX_LISTED` paths, sorted. */
  paths: string[];
  /** How many matched in total, which may exceed `paths.length`. */
  total: number;
};

/**
 * What the batch overview needs, which is the one thing the digest cannot read
 * off a compare: who merged into staging and when. The manifest already knows
 * it, so the caller passes it down rather than this module fetching PRs of its
 * own.
 */
export type BatchOverview = {
  prCount: number;
  /** Distinct PR authors, already sorted. */
  authors: string[];
  /** ISO timestamps of the first and last merge in the batch. */
  firstMergedAt: string | null;
  lastMergedAt: string | null;
};

export type StagingDigest = {
  overview: BatchOverview | null;
  envAdded: EnvVarMention[];
  envRemoved: EnvVarMention[];
  groups: DigestGroup[];
  breaking: Array<{ sha: string; subject: string }>;
  stats: {
    files: number;
    additions: number;
    deletions: number;
    commits: number;
    /** The compare hit GitHub's file cap, so the digest may be incomplete. */
    truncated: boolean;
  };
};

/** How many paths to name per group before collapsing into a count. */
const MAX_LISTED = 8;
/** How many env var names to print before collapsing into a count. */
const MAX_ENV = 12;
/** How many breaking-change commits to name. */
const MAX_BREAKING = 5;
/** Longest commit subject we print before eliding. */
const SUBJECT_MAX = 80;

// --- path classification -----------------------------------------------------

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Does this file declare environment variables by name? `.env` examples and
 * the typed env schema modules people write next to them (`env.ts` with a Zod
 * object) both spell one variable per line, starting with its name. */
function isEnvDeclarationFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (base.startsWith(".env") || base.endsWith(".env")) return true;
  if (/^env\.(ts|tsx|js|mjs|cjs|py|rb|go)$/.test(base)) return true;
  return /(^|\/)(env|environment)\.example($|\.)/.test(path.toLowerCase());
}

/**
 * The groups, in the order a release reviewer cares about them. First match
 * wins, so a file is only ever counted once: `prisma/migrations/...` is a
 * migration, not "other config".
 */
const GROUPS: Array<{
  id: DigestSectionId;
  label: string;
  matches: (path: string) => boolean;
}> = [
  {
    id: "migrations",
    label: "Database migrations",
    matches: (p) =>
      /(^|\/)(prisma\/migrations|migrations|migrate|db\/migrate|alembic\/versions)\//i.test(
        p,
      ) || /(^|\/)migration\.sql$/i.test(p),
  },
  {
    id: "schema",
    label: "Database schema",
    matches: (p) =>
      /(^|\/)schema\.prisma$/i.test(p) ||
      /(^|\/)(schema|structure)\.(sql|rb)$/i.test(p),
  },
  {
    id: "dependencies",
    label: "Dependencies",
    matches: (p) =>
      /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements(-\w+)?\.txt|pyproject\.toml|poetry\.lock|uv\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock)$/i.test(
        p,
      ),
  },
  {
    id: "workflows",
    label: "CI workflows",
    matches: (p) =>
      /^\.github\/(workflows|actions)\//i.test(p) ||
      /(^|\/)(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/i.test(
        p,
      ),
  },
  {
    id: "infra",
    label: "Infrastructure and deploy config",
    matches: (p) =>
      /(^|\/)(Dockerfile|Containerfile)(\.|$)/i.test(p) ||
      /(^|\/)docker-compose[\w.-]*\.ya?ml$/i.test(p) ||
      /\.(tf|tfvars)$/i.test(p) ||
      /(^|\/)(helm|charts|k8s|kubernetes|deploy|terraform|ansible)\//i.test(p) ||
      /(^|\/)(fly\.toml|vercel\.json|render\.yaml|Procfile|nginx\.conf)$/i.test(
        p,
      ),
  },
  {
    id: "tooling",
    label: "Build and tooling config",
    // Deliberately after `dependencies` and `infra`: `package.json` is a
    // dependency manifest first, and a Dockerfile is deploy config, not build
    // tooling, however much it also builds.
    matches: (p) =>
      /(^|\/)(next|vite|webpack|rollup|esbuild|babel|tailwind|postcss|vitest|jest|playwright|cypress|svelte|nuxt|astro|metro|craco)\.config\.[cm]?[jt]s(x)?$/i.test(
        p,
      ) ||
      /(^|\/)(tsconfig|jsconfig)([\w.-]*)\.json$/i.test(p) ||
      /(^|\/)(\.?eslint[\w.-]*|\.?prettier[\w.-]*|\.editorconfig|\.babelrc[\w.-]*|\.npmrc|\.nvmrc|\.node-version|\.tool-versions|pnpm-workspace\.yaml|turbo\.json|nx\.json|lerna\.json|Makefile|justfile|Rakefile)$/i.test(
        p,
      ),
  },
];

// --- patch reading -----------------------------------------------------------

/** Added lines of a unified diff, without the leading `+`. `+++` is the file
 * header, not content. */
function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Removed lines, same rules. */
function removedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1));
}

/** A plausible env var name: SCREAMING_SNAKE, at least three characters, so
 * `ID` and one-letter loop constants do not qualify. */
const NAME = "[A-Z][A-Z0-9_]{2,}";

/**
 * How code reads an environment variable, across the languages this bot is
 * likely to be pointed at. Every alternative captures the name in group 1 or 2,
 * so the scan takes whichever matched.
 */
const READ_PATTERNS: RegExp[] = [
  new RegExp(`process\\.env\\.(${NAME})`, "g"),
  new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
  new RegExp(`import\\.meta\\.env\\.(${NAME})`, "g"),
  new RegExp(`Deno\\.env\\.get\\(\\s*["'\`](${NAME})["'\`]`, "g"),
  new RegExp(`os\\.environ(?:\\.get)?[[(]\\s*["'](${NAME})["']`, "g"),
  new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "g"),
  new RegExp(`System\\.getenv\\(\\s*["'](${NAME})["']`, "g"),
  new RegExp(`ENV\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  // Case-insensitive for this one alone: Go spells it `os.Getenv`, PHP and C
  // spell it `getenv`, and the name is upper-cased either way.
  new RegExp(`\\bgetenv\\(\\s*["'\`](${NAME})["'\`]`, "gi"),
];

/** A declaration line in an env file or an env schema: the name is the first
 * thing on the line, followed by `=` or `:`. */
const DECLARATION = new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*[:=]`);

function namesInLine(line: string, declarationFile: boolean): string[] {
  const found: string[] = [];
  if (declarationFile) {
    const decl = DECLARATION.exec(line);
    if (decl) found.push(decl[1]);
  }
  for (const re of READ_PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const name = m[1];
      if (name) found.push(name);
    }
  }
  return found;
}

/**
 * Environment variables the batch adds and removes.
 *
 * A name that appears on both sides of the same file's diff is a move, a
 * reorder or a reformat, not a change in what has to be configured, so it is
 * dropped from both lists. Comment lines in env examples still count: a
 * commented-out `# FEATURE_FLAG=` is exactly the kind of thing an operator
 * needs to see, and the leading `#` is stripped before matching.
 */
function collectEnvVars(files: CompareFile[]): {
  added: EnvVarMention[];
  removed: EnvVarMention[];
} {
  const added = new Map<string, string>();
  const removed = new Map<string, string>();
  for (const file of files) {
    if (!file.patch) continue;
    const declarationFile = isEnvDeclarationFile(file.filename);
    const strip = (l: string) =>
      declarationFile ? l.replace(/^\s*#\s?/, "") : l;
    const inFileAdded = new Set<string>();
    const inFileRemoved = new Set<string>();
    for (const line of addedLines(file.patch)) {
      for (const n of namesInLine(strip(line), declarationFile)) {
        inFileAdded.add(n);
      }
    }
    for (const line of removedLines(file.patch)) {
      for (const n of namesInLine(strip(line), declarationFile)) {
        inFileRemoved.add(n);
      }
    }
    for (const name of inFileAdded) {
      if (inFileRemoved.has(name)) continue;
      if (!added.has(name)) added.set(name, file.filename);
    }
    for (const name of inFileRemoved) {
      if (inFileAdded.has(name)) continue;
      if (!removed.has(name)) removed.set(name, file.filename);
    }
  }
  // A name added in one file and removed in another is still an addition: the
  // reference moved, but the variable is live either way.
  for (const name of added.keys()) removed.delete(name);
  const toList = (m: Map<string, string>): EnvVarMention[] =>
    [...m.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return { added: toList(added), removed: toList(removed) };
}

// --- commits -----------------------------------------------------------------

/** Conventional-commit breaking marker: `feat(api)!: ...`. */
const BREAKING_SUBJECT = /^[a-zA-Z]+(\([^)]*\))?!:/;

function breakingCommits(
  commits: CompareCommit[],
): Array<{ sha: string; subject: string }> {
  const out: Array<{ sha: string; subject: string }> = [];
  for (const c of commits) {
    const [subject = "", ...rest] = c.message.split("\n");
    const isBreaking =
      BREAKING_SUBJECT.test(subject.trim()) ||
      /^BREAKING[ -]CHANGE:/m.test(rest.join("\n"));
    if (!isBreaking) continue;
    const trimmed = subject.trim();
    out.push({
      sha: c.sha.slice(0, 7),
      subject:
        trimmed.length > SUBJECT_MAX
          ? `${trimmed.slice(0, SUBJECT_MAX - 1)}…`
          : trimmed,
    });
  }
  return out;
}

// --- assembly ----------------------------------------------------------------

/**
 * Reduce a compare into the digest. Deterministic given its input: the body is
 * only PATCHed when the rendered block changes, so an unstable ordering here
 * would turn every reconcile into a visible edit on the release PR.
 */
export function buildStagingDigest(args: {
  files: CompareFile[];
  commits: CompareCommit[];
  filesTruncated: boolean;
  /** Omitted when the manifest is empty: there is no batch to describe. */
  overview?: BatchOverview | null;
}): StagingDigest {
  const groups: DigestGroup[] = [];
  for (const spec of GROUPS) {
    const paths = args.files
      .filter((f) => spec.matches(f.filename))
      .map((f) => f.filename)
      .sort();
    if (paths.length === 0) continue;
    groups.push({
      id: spec.id,
      label: spec.label,
      paths: paths.slice(0, MAX_LISTED),
      total: paths.length,
    });
  }
  const env = collectEnvVars(args.files);
  return {
    overview: args.overview ?? null,
    envAdded: env.added,
    envRemoved: env.removed,
    groups,
    breaking: breakingCommits(args.commits),
    stats: {
      files: args.files.length,
      additions: args.files.reduce((n, f) => n + f.additions, 0),
      deletions: args.files.reduce((n, f) => n + f.deletions, 0),
      commits: args.commits.length,
      truncated: args.filesTruncated,
    },
  };
}

/** `a`, `b` and 3 more. Keeps long lists from swallowing the PR body. */
function nameList(values: string[], total: number): string {
  const shown = values.map((v) => `\`${v}\``).join(", ");
  const extra = total - values.length;
  return extra > 0 ? `${shown} and ${extra} more` : shown;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-08-16`, in UTC. The raw form on purpose: this string is published to
 * GitHub rather than rendered in the app, which is the same call the other
 * comment builders make (see the note in `src/lib/ui/format.ts`). */
function isoDay(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** How many authors to name before collapsing into a count. */
const MAX_AUTHORS = 5;

/**
 * One line summarizing the batch itself: how big it is, whose work is in it,
 * and how long it has been accumulating. The age is the part worth having:
 * a batch that has been open three weeks is a different review from one opened
 * this morning, and nothing else in the PR says so.
 */
function overviewLine(o: BatchOverview): string | null {
  if (o.prCount === 0) return null;
  const parts = [`**${plural(o.prCount, "PR")}**`];
  if (o.authors.length > 0) {
    const shown = o.authors.slice(0, MAX_AUTHORS).map((a) => `@${a}`);
    const extra = o.authors.length - shown.length;
    parts.push(
      `from ${shown.join(", ")}${extra > 0 ? ` and ${plural(extra, "other")}` : ""}`,
    );
  }
  const first = o.firstMergedAt ? isoDay(o.firstMergedAt) : null;
  const last = o.lastMergedAt ? isoDay(o.lastMergedAt) : null;
  if (first && last) {
    if (first === last) {
      parts.push(`merged on ${first}`);
    } else {
      const days = Math.round(
        (new Date(o.lastMergedAt as string).getTime() -
          new Date(o.firstMergedAt as string).getTime()) /
          DAY_MS,
      );
      parts.push(
        `merged between ${first} and ${last}${days > 0 ? ` (${plural(days, "day")})` : ""}`,
      );
    }
  }
  return `- ${parts.join(", ")}.`;
}

/**
 * Render the digest as markdown lines, or an empty array when there is nothing
 * worth saying. Callers splice this into the manifest block; it never renders
 * a heading of its own so an empty digest costs no whitespace.
 *
 * `sections` is the project's configuration. Disabling one drops its line and
 * nothing else, so a project that only wants to hear about environment
 * variables gets a one-line section rather than a differently-shaped digest.
 */
export function renderDigestLines(
  digest: StagingDigest,
  sections: ReadonlySet<DigestSectionId> = new Set(ALL_DIGEST_SECTION_IDS),
): string[] {
  const lines: string[] = [];
  if (sections.has("overview") && digest.overview) {
    const line = overviewLine(digest.overview);
    if (line) lines.push(line);
  }
  if (sections.has("env") && digest.envAdded.length > 0) {
    const names = digest.envAdded.slice(0, MAX_ENV).map((e) => e.name);
    lines.push(
      `- **New environment variables** (${digest.envAdded.length}): ${nameList(names, digest.envAdded.length)}. Set them on production before merging.`,
    );
  }
  if (sections.has("env") && digest.envRemoved.length > 0) {
    const names = digest.envRemoved.slice(0, MAX_ENV).map((e) => e.name);
    lines.push(
      `- **Environment variables no longer referenced** (${digest.envRemoved.length}): ${nameList(names, digest.envRemoved.length)}.`,
    );
  }
  if (sections.has("breaking") && digest.breaking.length > 0) {
    const shown = digest.breaking
      .slice(0, MAX_BREAKING)
      .map((c) => `${c.sha} ${c.subject}`);
    const extra = digest.breaking.length - shown.length;
    lines.push(
      `- **Breaking changes** (${digest.breaking.length}): ${shown.join("; ")}${extra > 0 ? `; and ${extra} more` : ""}`,
    );
  }
  for (const group of digest.groups) {
    if (!sections.has(group.id)) continue;
    lines.push(
      `- **${group.label}** (${group.total}): ${nameList(group.paths, group.total)}`,
    );
  }
  // The footer is a footer: it annotates the section, so on its own it is not
  // worth a heading and a horizontal rule of whitespace.
  if (lines.length === 0) return [];
  if (!sections.has("stats")) return lines;
  const s = digest.stats;
  lines.push("");
  lines.push(
    `<sub>${plural(s.files, "file")}${s.truncated ? "+" : ""} changed, +${s.additions} / -${s.deletions}, across ${plural(s.commits, "commit")}${s.truncated ? " (compare truncated by GitHub, so this may be partial)" : ""}.</sub>`,
  );
  return lines;
}
