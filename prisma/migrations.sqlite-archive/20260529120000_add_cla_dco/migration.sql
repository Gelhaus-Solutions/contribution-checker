-- AlterTable
ALTER TABLE "PrCheck" ADD COLUMN "gateReason" TEXT;

-- CreateTable
CREATE TABLE "ClaDocumentVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceRepoId" TEXT,
    "sourcePath" TEXT,
    "sourceRef" TEXT,
    "sourceCommitSha" TEXT,
    "requireResign" BOOLEAN NOT NULL DEFAULT false,
    "publishedById" TEXT,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaDocumentVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaSignature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "ghId" INTEGER NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "emailSnapshot" TEXT,
    "legalName" TEXT NOT NULL,
    "affirmation" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT true,
    "documentVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "applicationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" DATETIME,
    "revokeReason" TEXT,
    "signedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaSignature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClaSignature_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ClaDocumentVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClaSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaSignature_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CorporateCla" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "signatureId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "signatoryTitle" TEXT,
    "contactEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CorporateCla_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CorporateCla_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ClaDocumentVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CorporateCla_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "ClaSignature" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CclaRosterMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "corporateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "addedById" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" DATETIME,
    "disputedAt" DATETIME,
    "disputeNote" TEXT,
    CONSTRAINT "CclaRosterMember_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "CorporateCla" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CclaRosterMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaWaiver" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedById" TEXT,
    "revokedAt" DATETIME,
    CONSTRAINT "ClaWaiver_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaEventLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorGhId" INTEGER,
    "signatureId" TEXT,
    "documentVersionId" TEXT,
    "rosterMemberId" TEXT,
    "corporateId" TEXT,
    "waiverId" TEXT,
    "prevHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaEventLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "formSchema" TEXT NOT NULL DEFAULT '[]',
    "templateId" TEXT,
    "cooldownDays" INTEGER,
    "bypassHandles" TEXT NOT NULL DEFAULT '[]',
    "bypassCollabs" BOOLEAN NOT NULL DEFAULT true,
    "labelsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "labelPending" TEXT NOT NULL DEFAULT 'contribution:pending',
    "labelApproved" TEXT NOT NULL DEFAULT 'contribution:approved',
    "labelDenied" TEXT NOT NULL DEFAULT 'contribution:denied',
    "labelEvaluate" TEXT NOT NULL DEFAULT 'contribution:evaluate',
    "checkerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trackWhenDisabled" BOOLEAN NOT NULL DEFAULT false,
    "checksEnabled" BOOLEAN NOT NULL DEFAULT true,
    "qualityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "qualityConfig" TEXT NOT NULL DEFAULT '{}',
    "qualityCommentMin" INTEGER NOT NULL DEFAULT 20,
    "prTemplateHoneypots" TEXT NOT NULL DEFAULT '[]',
    "qualityTemplateMatchPct" INTEGER NOT NULL DEFAULT 80,
    "requireApprovalCount" INTEGER NOT NULL DEFAULT 0,
    "applicationRequired" BOOLEAN NOT NULL DEFAULT true,
    "claEnabled" BOOLEAN NOT NULL DEFAULT false,
    "claRequired" BOOLEAN NOT NULL DEFAULT true,
    "claCorporateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "claPlacementEmbed" BOOLEAN NOT NULL DEFAULT true,
    "claPlacementStandalone" BOOLEAN NOT NULL DEFAULT true,
    "labelClaPending" TEXT NOT NULL DEFAULT 'contribution:cla-pending',
    "minIclaVersion" INTEGER NOT NULL DEFAULT 0,
    "minCclaVersion" INTEGER NOT NULL DEFAULT 0,
    "currentIclaVersionId" TEXT,
    "currentCclaVersionId" TEXT,
    "claAutoVersionRequiresResign" BOOLEAN NOT NULL DEFAULT false,
    "dcoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "requireApprovalCount", "slug", "templateId", "trackWhenDisabled", "updatedAt") SELECT "bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "requireApprovalCount", "slug", "templateId", "trackWhenDisabled", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ClaDocumentVersion_projectId_kind_idx" ON "ClaDocumentVersion"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ClaDocumentVersion_projectId_kind_version_key" ON "ClaDocumentVersion"("projectId", "kind", "version");

-- CreateIndex
CREATE INDEX "ClaSignature_projectId_ghId_status_idx" ON "ClaSignature"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "ClaSignature_ghId_idx" ON "ClaSignature"("ghId");

-- CreateIndex
CREATE INDEX "ClaSignature_versionId_idx" ON "ClaSignature"("versionId");

-- CreateIndex
CREATE INDEX "ClaSignature_applicationId_idx" ON "ClaSignature"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateCla_signatureId_key" ON "CorporateCla"("signatureId");

-- CreateIndex
CREATE INDEX "CorporateCla_projectId_status_idx" ON "CorporateCla"("projectId", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_projectId_ghId_status_idx" ON "CclaRosterMember"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_projectId_ghLogin_status_idx" ON "CclaRosterMember"("projectId", "ghLogin", "status");

-- CreateIndex
CREATE INDEX "CclaRosterMember_corporateId_idx" ON "CclaRosterMember"("corporateId");

-- CreateIndex
CREATE INDEX "ClaWaiver_projectId_ghId_status_idx" ON "ClaWaiver"("projectId", "ghId", "status");

-- CreateIndex
CREATE INDEX "ClaWaiver_projectId_ghLogin_status_idx" ON "ClaWaiver"("projectId", "ghLogin", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClaEventLog_signatureId_key" ON "ClaEventLog"("signatureId");

-- CreateIndex
CREATE INDEX "ClaEventLog_projectId_kind_idx" ON "ClaEventLog"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ClaEventLog_projectId_seq_key" ON "ClaEventLog"("projectId", "seq");

