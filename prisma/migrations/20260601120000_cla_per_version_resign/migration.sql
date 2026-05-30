-- AlterTable: per-version re-sign flag (mutable gate input, replaces the floor)
ALTER TABLE "ClaDocumentVersion" ADD COLUMN "resignRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: repo-file change review mode toggle
ALTER TABLE "Project" ADD COLUMN "claRepoFileReviewMode" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: pending repo-file change awaiting admin review
CREATE TABLE "ClaPendingChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceRepoId" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceRef" TEXT,
    "detectedCommitSha" TEXT,
    "detectedContent" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "publishedVersionId" TEXT,
    "rejectReason" TEXT,

    CONSTRAINT "ClaPendingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaPendingChange_projectId_status_idx" ON "ClaPendingChange"("projectId", "status");
CREATE INDEX "ClaPendingChange_projectId_kind_sourcePath_status_idx" ON "ClaPendingChange"("projectId", "kind", "sourcePath", "status");

-- AddForeignKey
ALTER TABLE "ClaPendingChange" ADD CONSTRAINT "ClaPendingChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: materialize the old monotonic floor into per-version resignRequired
-- flags, preserving exact current coverage behavior. A signature satisfied the
-- old gate iff documentVersion >= floor; equivalently a version is stale iff
-- version < floor. Touches no ClaEventLog rows (hash chain unaffected).
UPDATE "ClaDocumentVersion" d
SET "resignRequired" = true
FROM "Project" p
WHERE d."projectId" = p."id"
  AND d."kind" = 'ICLA'
  AND d."version" < p."minIclaVersion";

UPDATE "ClaDocumentVersion" d
SET "resignRequired" = true
FROM "Project" p
WHERE d."projectId" = p."id"
  AND d."kind" = 'CCLA'
  AND d."version" < p."minCclaVersion";
