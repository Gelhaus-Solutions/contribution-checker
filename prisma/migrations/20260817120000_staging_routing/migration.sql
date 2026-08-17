-- Staging branch routing: PRs opened against a repo's default branch are
-- rewritten to target the project's staging branch, and one bot-owned
-- aggregate PR (staging -> default) stays open listing the batch.
--
-- Project gains the two independent switches, the branch name, and the two
-- new configurable labels (the batch marker and the per-PR escape hatch).
-- Repo gains three caches: the default branch name (so the reconciler does not
-- need a GET /repos call on every run), the tracked aggregate PR number, and
-- the timestamp of the previous batch's merge (PRs merged into staging before
-- it are already in the default branch and must not be re-listed).
-- The two staging labels sit outside the `contribution:` namespace on purpose:
-- setLabels() strips every `contribution:*` label it did not just set, so a
-- staging label in that namespace would be wiped by the next gate converge.
ALTER TABLE "Project" ADD COLUMN "labelStagingBatch" TEXT NOT NULL DEFAULT 'staging:batch';
ALTER TABLE "Project" ADD COLUMN "labelStagingOptOut" TEXT NOT NULL DEFAULT 'staging:opt-out';
ALTER TABLE "Project" ADD COLUMN "stagingRetargetEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "stagingBatchPrEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "stagingBranch" TEXT NOT NULL DEFAULT 'staging';

ALTER TABLE "Repo" ADD COLUMN "defaultBranch" TEXT;
ALTER TABLE "Repo" ADD COLUMN "stagingBatchPrNumber" INTEGER;
ALTER TABLE "Repo" ADD COLUMN "stagingBatchSince" TIMESTAMP(3);
