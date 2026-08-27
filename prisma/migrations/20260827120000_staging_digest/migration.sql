-- The "before you merge" digest on the aggregate staging PR: environment
-- variables the batch adds or drops, migrations, dependency, CI, tooling and
-- infrastructure changes, breaking-change commits, and a batch overview.
--
-- Off by default, and deliberately so for projects that already run an
-- aggregate PR. The digest changes the shape of a description reviewers are
-- used to reading, and a release PR is the wrong place to surprise someone.
ALTER TABLE "Project" ADD COLUMN "stagingDigestEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Which sections print, as a JSON array of ids from DIGEST_SECTIONS in
-- src/lib/github/staging-digest.ts. The default spells every id out rather
-- than leaving the column empty: parseDigestSections reads "missing or
-- unreadable" as "print everything", but an empty ARRAY is a real answer
-- ("print nothing"), so the two must not be spelled the same way.
ALTER TABLE "Project" ADD COLUMN "stagingDigestSections" TEXT NOT NULL
  DEFAULT '["overview","env","breaking","migrations","schema","dependencies","workflows","infra","tooling","stats"]';

-- Per-repo override of the switch above. NULL means "inherit the project",
-- like the other staging overrides. The section list stays project-wide.
ALTER TABLE "Repo" ADD COLUMN "stagingDigestEnabled" BOOLEAN;
