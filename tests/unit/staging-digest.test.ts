import { describe, expect, it } from "vitest";
import {
  ALL_DIGEST_SECTION_IDS,
  buildStagingDigest,
  DIGEST_SECTIONS,
  parseDigestSections,
  renderDigestLines,
  serializeDigestSections,
  type CompareFile,
  type DigestSectionId,
} from "@/lib/github/staging-digest";

function file(
  filename: string,
  patch: string | null,
  overrides: Partial<CompareFile> = {},
): CompareFile {
  return {
    filename,
    previousFilename: null,
    status: "modified",
    additions: 0,
    deletions: 0,
    patch,
    ...overrides,
  };
}

function digestOf(files: CompareFile[], commits: string[] = []) {
  return buildStagingDigest({
    files,
    commits: commits.map((message, i) => ({
      sha: `${i}`.repeat(40),
      message,
    })),
    filesTruncated: false,
  });
}

describe("environment variables", () => {
  it("reads new keys out of a .env example", () => {
    const d = digestOf([
      file(
        ".env.example",
        [
          "@@ -1,2 +1,4 @@",
          " DATABASE_URL=postgres://localhost/app",
          "+STRIPE_SECRET_KEY=",
          "+# FEATURE_DIGEST=false",
        ].join("\n"),
      ),
    ]);
    expect(d.envAdded.map((e) => e.name)).toEqual([
      "FEATURE_DIGEST",
      "STRIPE_SECRET_KEY",
    ]);
    expect(d.envAdded[0].source).toBe(".env.example");
  });

  // The named case for this repo: variables are declared in a Zod schema in
  // `env.ts`, never in a checked-in `.env`.
  it("reads new keys out of a typed env schema module", () => {
    const d = digestOf([
      file(
        "src/lib/env.ts",
        ["@@", " const schema = z.object({", "+  VAULT_ADDR: z.string(),"].join(
          "\n",
        ),
      ),
    ]);
    expect(d.envAdded.map((e) => e.name)).toEqual(["VAULT_ADDR"]);
  });

  it("reads keys code newly reads, in any of the usual dialects", () => {
    const d = digestOf([
      file("src/a.ts", "@@\n+  const t = process.env.NEW_TOKEN;"),
      file("worker/b.py", '@@\n+key = os.environ["PY_SECRET"]'),
      file("cmd/c.go", '@@\n+v := os.Getenv("GO_ONLY")\n+w := getenv("C_SECRET")'),
    ]);
    expect(d.envAdded.map((e) => e.name)).toEqual([
      "C_SECRET",
      "GO_ONLY",
      "NEW_TOKEN",
      "PY_SECRET",
    ]);
  });

  // A reformat or a reorder touches both sides of the diff and changes nothing
  // an operator has to do.
  it("ignores a key that is only moved within a file", () => {
    const d = digestOf([
      file(
        ".env.example",
        ["@@", "-API_URL=http://a", "+API_URL=http://b", "+REAL_NEW=1"].join(
          "\n",
        ),
      ),
    ]);
    expect(d.envAdded.map((e) => e.name)).toEqual(["REAL_NEW"]);
    expect(d.envRemoved).toEqual([]);
  });

  it("treats a key moved between files as an addition, not a removal", () => {
    const d = digestOf([
      file("src/old.ts", "@@\n-  process.env.SHARED_KEY"),
      file("src/new.ts", "@@\n+  process.env.SHARED_KEY"),
    ]);
    expect(d.envAdded.map((e) => e.name)).toEqual(["SHARED_KEY"]);
    expect(d.envRemoved).toEqual([]);
  });

  it("reports keys the batch stopped referencing", () => {
    const d = digestOf([file(".env.example", "@@\n-LEGACY_TOKEN=x")]);
    expect(d.envRemoved.map((e) => e.name)).toEqual(["LEGACY_TOKEN"]);
    expect(d.envAdded).toEqual([]);
  });

  it("does not mistake an all-caps constant for a variable", () => {
    const d = digestOf([file("src/a.ts", "@@\n+const MAX_RETRIES = 5;")]);
    expect(d.envAdded).toEqual([]);
  });

  it("skips binary and oversized files, which carry no patch", () => {
    const d = digestOf([file("logo.png", null)]);
    expect(d.envAdded).toEqual([]);
  });
});

describe("file groups", () => {
  it("names migrations, dependencies, workflows and infrastructure", () => {
    const d = digestOf([
      file("prisma/migrations/20260101_x/migration.sql", null),
      file("package.json", null),
      file("pnpm-lock.yaml", null),
      file(".github/workflows/ci.yml", null),
      file("Dockerfile", null),
      file("src/app/page.tsx", null),
    ]);
    const byId = Object.fromEntries(d.groups.map((g) => [g.id, g]));
    expect(byId.migrations.paths).toEqual([
      "prisma/migrations/20260101_x/migration.sql",
    ]);
    expect(byId.dependencies.paths).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(byId.workflows.paths).toEqual([".github/workflows/ci.yml"]);
    expect(byId.infra.paths).toEqual(["Dockerfile"]);
    // Ordinary source files are not a group: everything is a source change.
    expect(d.groups.map((g) => g.id)).not.toContain("src/app/page.tsx");
  });

  it("counts a file once, in the first group that claims it", () => {
    const d = digestOf([file("prisma/schema.prisma", null)]);
    expect(d.groups.map((g) => g.id)).toEqual(["schema"]);
  });

  it("collapses a long list into a count", () => {
    const files = Array.from({ length: 11 }, (_, i) =>
      file(`prisma/migrations/2026010${i}_x/migration.sql`, null),
    );
    const d = digestOf(files);
    expect(d.groups[0].total).toBe(11);
    expect(d.groups[0].paths).toHaveLength(8);
    expect(renderDigestLines(d)[0]).toContain("and 3 more");
  });
});

describe("breaking changes", () => {
  it("picks up the conventional-commit marker and the body trailer", () => {
    const d = digestOf(
      [],
      [
        "feat(api)!: drop the v1 endpoint",
        "fix: ordinary change",
        "refactor: move things\n\nBREAKING CHANGE: the config key was renamed",
        "chore: mentions BREAKING CHANGE: only mid-sentence",
      ],
    );
    expect(d.breaking.map((c) => c.subject)).toEqual([
      "feat(api)!: drop the v1 endpoint",
      "refactor: move things",
    ]);
    expect(d.breaking[0].sha).toHaveLength(7);
  });
});

describe("renderDigestLines", () => {
  it("says nothing at all when nothing is notable", () => {
    expect(renderDigestLines(digestOf([file("README.md", "@@\n+text")]))).toEqual(
      [],
    );
  });

  it("leads with the environment variables and closes with the stats", () => {
    const d = buildStagingDigest({
      files: [
        file(".env.example", "@@\n+NEW_KEY=1", {
          additions: 1,
          deletions: 0,
        }),
        file("package.json", null, { additions: 2, deletions: 1 }),
      ],
      commits: [{ sha: "a".repeat(40), message: "feat: add" }],
      filesTruncated: false,
    });
    const lines = renderDigestLines(d);
    expect(lines[0]).toContain("New environment variables");
    expect(lines[0]).toContain("`NEW_KEY`");
    expect(lines[0]).toContain("Set them on production before merging");
    expect(lines.at(-1)).toContain("2 files changed, +3 / -1");
    expect(lines.at(-1)).toContain("1 commit");
  });

  it("admits when GitHub truncated the compare", () => {
    const d = buildStagingDigest({
      files: [file("package.json", null)],
      commits: [],
      filesTruncated: true,
    });
    expect(renderDigestLines(d).at(-1)).toContain("may be partial");
  });

  it("is stable across identical inputs, so no reconcile writes a fresh body", () => {
    const files = [
      file("src/b.ts", "@@\n+process.env.B_KEY"),
      file("src/a.ts", "@@\n+process.env.A_KEY"),
      file(".github/workflows/b.yml", null),
      file(".github/workflows/a.yml", null),
    ];
    const first = renderDigestLines(digestOf(files));
    const second = renderDigestLines(digestOf([...files].reverse()));
    expect(first).toEqual(second);
  });
});

describe("build and tooling config", () => {
  it("is its own group, distinct from dependencies and infrastructure", () => {
    const d = digestOf([
      file("next.config.ts", null),
      file("tsconfig.json", null),
      file(".eslintrc.json", null),
      file("turbo.json", null),
      file("Makefile", null),
      file("package.json", null),
      file("Dockerfile", null),
    ]);
    const byId = Object.fromEntries(d.groups.map((g) => [g.id, g]));
    expect(byId.tooling.paths).toEqual([
      ".eslintrc.json",
      "Makefile",
      "next.config.ts",
      "tsconfig.json",
      "turbo.json",
    ]);
    // package.json is a dependency manifest first; a Dockerfile is deploy
    // config, not build tooling.
    expect(byId.dependencies.paths).toEqual(["package.json"]);
    expect(byId.infra.paths).toEqual(["Dockerfile"]);
  });
});

describe("batch overview", () => {
  const overview = {
    prCount: 4,
    authors: ["hubot", "octocat"],
    firstMergedAt: "2026-08-12T09:00:00Z",
    lastMergedAt: "2026-08-25T17:00:00Z",
  };

  const lineFor = (o: Parameters<typeof buildStagingDigest>[0]["overview"]) =>
    renderDigestLines(
      buildStagingDigest({ files: [], commits: [], filesTruncated: false, overview: o }),
    )[0];

  it("names the PR count, the authors and the span", () => {
    const line = lineFor(overview);
    expect(line).toContain("**4 PRs**");
    expect(line).toContain("from @hubot, @octocat");
    expect(line).toContain("merged between 2026-08-12 and 2026-08-25");
    expect(line).toContain("(13 days)");
  });

  it("collapses a long author list", () => {
    const line = lineFor({
      ...overview,
      prCount: 9,
      authors: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(line).toContain("@a, @b, @c, @d, @e and 2 others");
  });

  it("says the day once for a batch that merged inside one", () => {
    const line = lineFor({
      ...overview,
      firstMergedAt: "2026-08-25T09:00:00Z",
      lastMergedAt: "2026-08-25T17:00:00Z",
    });
    expect(line).toContain("merged on 2026-08-25");
    expect(line).not.toContain("between");
  });

  it("drops the dates rather than the line when GitHub gave us none", () => {
    const line = lineFor({ ...overview, firstMergedAt: null, lastMergedAt: null });
    expect(line).toContain("**4 PRs**");
    expect(line).not.toContain("merged");
  });

  it("renders nothing for an empty batch", () => {
    expect(lineFor({ ...overview, prCount: 0, authors: [] })).toBeUndefined();
  });
});

describe("section configuration", () => {
  const digest = () =>
    buildStagingDigest({
      files: [
        file(".env.example", "@@\n+NEW_KEY=1", { additions: 1 }),
        file("prisma/migrations/20260101_x/migration.sql", null),
      ],
      commits: [{ sha: "a".repeat(40), message: "feat!: break it" }],
      filesTruncated: false,
      overview: {
        prCount: 2,
        authors: ["octocat"],
        firstMergedAt: null,
        lastMergedAt: null,
      },
    });

  const only = (...ids: DigestSectionId[]) =>
    renderDigestLines(digest(), new Set(ids));

  it("prints every section by default", () => {
    const lines = renderDigestLines(digest()).join("\n");
    for (const fragment of [
      "2 PRs",
      "New environment variables",
      "Breaking changes",
      "Database migrations",
      "files changed",
    ]) {
      expect(lines).toContain(fragment);
    }
  });

  it("drops a disabled section and nothing else", () => {
    const lines = only("env", "stats").join("\n");
    expect(lines).toContain("New environment variables");
    expect(lines).toContain("files changed");
    expect(lines).not.toContain("Database migrations");
    expect(lines).not.toContain("Breaking changes");
    expect(lines).not.toContain("2 PRs");
  });

  it("drops the footer on its own", () => {
    const lines = only("env");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("New environment variables");
  });

  // The footer annotates the section; on its own it has nothing to annotate.
  it("renders nothing when only the footer is enabled", () => {
    expect(only("stats")).toEqual([]);
  });

  it("renders nothing when no section is enabled", () => {
    expect(renderDigestLines(digest(), new Set())).toEqual([]);
  });
});

describe("parseDigestSections", () => {
  it("round-trips through the serializer in catalog order", () => {
    const raw = serializeDigestSections(["stats", "env"]);
    expect(raw).toBe('["env","stats"]');
    expect([...parseDigestSections(raw)]).toEqual(["env", "stats"]);
  });

  // The digest already sits behind its own switch, so a project that has it on
  // has asked to see something: an unreadable column must not blank the body.
  it("falls back to everything when the column is missing or malformed", () => {
    for (const raw of [null, undefined, "", "not json", '{"env":true}']) {
      expect([...parseDigestSections(raw)].sort()).toEqual(
        [...ALL_DIGEST_SECTION_IDS].sort(),
      );
    }
  });

  it("reads an empty array as an explicit nothing", () => {
    expect(parseDigestSections("[]").size).toBe(0);
  });

  it("drops ids that are no longer in the catalog", () => {
    expect([...parseDigestSections('["env","retired_section"]')]).toEqual([
      "env",
    ]);
  });

  it("keeps every file group reachable from the catalog", () => {
    // A group whose id is not a section can never be turned off, and worse,
    // never turned on: renderDigestLines filters on section membership.
    const groupIds = digestOf([
      file("prisma/migrations/a/migration.sql", null),
      file("prisma/schema.prisma", null),
      file("package.json", null),
      file(".github/workflows/ci.yml", null),
      file("Dockerfile", null),
      file("tsconfig.json", null),
    ]).groups.map((g) => g.id);
    const catalog = new Set(DIGEST_SECTIONS.map((s) => s.id));
    for (const id of groupIds) expect(catalog.has(id)).toBe(true);
  });
});
