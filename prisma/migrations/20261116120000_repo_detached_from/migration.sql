-- The installation an App-linked repo was detached from, so it can be relinked
-- with its row (staging settings, release PR, checks, batches) kept.
ALTER TABLE "Repo" ADD COLUMN "detachedFromInstallationId" INTEGER;
