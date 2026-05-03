-- AlterTable
ALTER TABLE "PrCheck" ADD COLUMN "checkRunId" TEXT;
ALTER TABLE "PrCheck" ADD COLUMN "headSha" TEXT;

-- CreateTable
CREATE TABLE "PrQuality" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prCheckId" TEXT NOT NULL,
    "signalsRaw" TEXT NOT NULL DEFAULT '{}',
    "fetchedRaw" TEXT NOT NULL DEFAULT '{}',
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrQuality_prCheckId_fkey" FOREIGN KEY ("prCheckId") REFERENCES "PrCheck" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "labelsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "labelPending" TEXT NOT NULL DEFAULT 'contribution:pending',
    "labelApproved" TEXT NOT NULL DEFAULT 'contribution:approved',
    "labelDenied" TEXT NOT NULL DEFAULT 'contribution:denied',
    "checkerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trackWhenDisabled" BOOLEAN NOT NULL DEFAULT false,
    "checksEnabled" BOOLEAN NOT NULL DEFAULT true,
    "qualityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "qualityConfig" TEXT NOT NULL DEFAULT '{}',
    "qualityCommentMin" INTEGER NOT NULL DEFAULT 20,
    "prTemplateHoneypots" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("bypassCollabs", "bypassHandles", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelPending", "labelsEnabled", "name", "slug", "templateId", "updatedAt", "webhookSecret", "webhookUrl") SELECT "bypassCollabs", "bypassHandles", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelPending", "labelsEnabled", "name", "slug", "templateId", "updatedAt", "webhookSecret", "webhookUrl" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PrQuality_prCheckId_key" ON "PrQuality"("prCheckId");

-- CreateIndex
CREATE INDEX "PrQuality_prCheckId_idx" ON "PrQuality"("prCheckId");
