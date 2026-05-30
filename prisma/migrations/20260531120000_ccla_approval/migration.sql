-- AlterTable
ALTER TABLE "Project" ADD COLUMN "claCorporateRequiresApproval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CorporateCla" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "CorporateCla" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "CorporateCla" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "CorporateCla" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "CorporateCla" ADD COLUMN "rejectReason" TEXT;
