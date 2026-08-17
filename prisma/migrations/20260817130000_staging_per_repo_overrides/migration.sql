-- Per-repo staging overrides. The project columns added in
-- 20260817120000_staging_routing stay as the default for every repo; these
-- three are the override.
--
-- All nullable, with NULL meaning "inherit the project default" rather than
-- "off". A repo has to be able to say "off" while the project says "on", which
-- a plain boolean cannot express, and defaulting them to false would silently
-- opt every newly linked repo out of a project-wide rollout.
ALTER TABLE "Repo" ADD COLUMN "stagingRetargetEnabled" BOOLEAN;
ALTER TABLE "Repo" ADD COLUMN "stagingBatchPrEnabled" BOOLEAN;
ALTER TABLE "Repo" ADD COLUMN "stagingBranch" TEXT;
