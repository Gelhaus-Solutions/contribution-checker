-- Durable state for the staging sync batching window.
--
-- The window used to live only in the `stagingBatch` entity workflow, which
-- completes ~2 minutes after the batch settles. The next push to the default
-- branch then started a fresh run with no memory of the last sync and merged
-- immediately, so a busy default branch buried the staging branch under one
-- "Merge <default> into <staging>" commit per push regardless of the window.
--
-- Nullable: NULL means "never synced", which allows a sync straight away.
ALTER TABLE "Repo" ADD COLUMN "stagingLastSyncAt" TIMESTAMP(3);
