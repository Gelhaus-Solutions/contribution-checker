-- QA on the staging batch: record, per merged PR, whether anyone actually
-- verified it before the release ships.
--
-- The manifest in the aggregate PR body already answers "what ships". It says
-- nothing about verification, so on a large batch the state of the release is
-- unknowable and the failure mode is silent: the aggregate PR merges with an
-- unverified PR in it.
--
-- A batch is the content range (`default...staging`), not the aggregate PR.
-- An aggregate PR closed without merging leaves the commits where they are, so
-- the next reconcile opens a new PR over the same content and the QA already
-- recorded is still valid. Only a merge ships a batch.

-- ----- Project-level configuration -----
ALTER TABLE "Project" ADD COLUMN "stagingQaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "qaCheckEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "qaFailedLabel" TEXT NOT NULL DEFAULT 'qa:failed';
ALTER TABLE "Project" ADD COLUMN "qaStandingChecks" TEXT NOT NULL DEFAULT '[]';

-- Nullable, like every other per-repo staging override: NULL means "inherit the
-- project", so adding a repo cannot silently opt it out of a rollout.
ALTER TABLE "Repo" ADD COLUMN "stagingQaEnabled" BOOLEAN;

-- ----- The batch -----
CREATE TABLE "StagingBatch" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "prNumber" INTEGER,
    "qaCheckRunId" TEXT,
    "qaLabelApplied" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagingBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StagingBatch_repoId_status_idx" ON "StagingBatch"("repoId", "status");
CREATE INDEX "StagingBatch_repoId_openedAt_idx" ON "StagingBatch"("repoId", "openedAt");

ALTER TABLE "StagingBatch" ADD CONSTRAINT "StagingBatch_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- One thing to verify -----
-- Re-derived on every reconcile like the manifest, EXCEPT the qa* columns:
-- those are human input and a reconcile never overwrites them. The single
-- exception is a changed "mergeCommitSha", which means the PR was re-merged and
-- the code under test is no longer the code that was verified.
CREATE TABLE "StagingBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prNumber" INTEGER,
    "title" TEXT NOT NULL,
    "authorLogin" TEXT,
    "mergeCommitSha" TEXT,
    "mergedAt" TIMESTAMP(3),
    "labels" TEXT NOT NULL DEFAULT '[]',
    "linkedIssues" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "qaSteps" TEXT,
    "qaStatus" TEXT NOT NULL DEFAULT 'QA_PENDING',
    "qaById" TEXT,
    "qaByExternal" TEXT,
    "qaAt" TIMESTAMP(3),
    "qaNotes" TEXT,
    "qaLabelApplied" BOOLEAN NOT NULL DEFAULT false,
    "droppedAt" TIMESTAMP(3),
    "externalProvider" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "externalHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagingBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StagingBatchItem_batchId_key_key" ON "StagingBatchItem"("batchId", "key");
CREATE INDEX "StagingBatchItem_batchId_qaStatus_idx" ON "StagingBatchItem"("batchId", "qaStatus");
CREATE INDEX "StagingBatchItem_externalProvider_externalId_idx" ON "StagingBatchItem"("externalProvider", "externalId");

ALTER TABLE "StagingBatchItem" ADD CONSTRAINT "StagingBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StagingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL rather than CASCADE: losing the reviewer's account must not delete
-- the record that the item was verified.
ALTER TABLE "StagingBatchItem" ADD CONSTRAINT "StagingBatchItem_qaById_fkey" FOREIGN KEY ("qaById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----- External board mirror -----
-- Credentials live here as plain columns, following the ProjectWebhook.secret
-- precedent. They are read only inside the sync activity, so they never enter
-- Temporal workflow history.
CREATE TABLE "QaBoardLink" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "apiKey" TEXT,
    "hookId" TEXT,
    "statusMap" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPulledAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaBoardLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QaBoardLink_repoId_provider_key" ON "QaBoardLink"("repoId", "provider");

ALTER TABLE "QaBoardLink" ADD CONSTRAINT "QaBoardLink_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
