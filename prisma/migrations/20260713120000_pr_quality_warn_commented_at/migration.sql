-- Track when the public low-score warning comment was posted for a PR, so
-- synchronize re-runs of quality scoring never post the warning twice.
ALTER TABLE "PrQuality" ADD COLUMN "warnCommentedAt" TIMESTAMP(3);
