/**
 * Path classification shared by the staging digest and the path guard.
 *
 * Both features ask the same question of a filename ("is this a migration? a CI
 * workflow? a dependency manifest?") and answer it the same way, so the
 * predicates live here rather than in two copies that drift. The digest reads
 * them to decide what a release PR's description should call out; the guard
 * reads them to decide whether a PR needs a human to sign off. A regex fixed for
 * one is fixed for the other.
 *
 * They are heuristics over a path and nothing else. No I/O, no patch reading:
 * whichever caller needs more than a filename does that work itself.
 */

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export type FileGroupId =
  | "migrations"
  | "schema"
  | "dependencies"
  | "workflows"
  | "infra"
  | "tooling";

export type FileGroupSpec = {
  id: FileGroupId;
  label: string;
  matches: (path: string) => boolean;
};

/**
 * The groups, in the order a release reviewer cares about them. First match
 * wins for the digest, so a file is only ever counted once: `prisma/migrations/
 * ...` is a migration, not "other config".
 *
 * The guard does not care about first-match-wins (a file that trips two guarded
 * rules is guarded either way), but it iterates the same list so the two
 * features cannot disagree about what a path is.
 */
export const FILE_GROUPS: FileGroupSpec[] = [
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
      /(^|\/)(helm|charts|k8s|kubernetes|deploy|terraform|ansible)\//i.test(
        p,
      ) ||
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

/** Does this file declare environment variables by name? `.env` examples and
 * the typed env schema modules people write next to them (`env.ts` with a Zod
 * object) both spell one variable per line, starting with its name. */
export function isEnvDeclarationFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (base.startsWith(".env") || base.endsWith(".env")) return true;
  if (/^env\.(ts|tsx|js|mjs|cjs|py|rb|go)$/.test(base)) return true;
  return /(^|\/)(env|environment)\.example($|\.)/.test(path.toLowerCase());
}
