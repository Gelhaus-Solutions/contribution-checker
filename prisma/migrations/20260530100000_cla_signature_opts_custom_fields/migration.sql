-- AlterTable
ALTER TABLE "ClaSignature" ADD COLUMN "customFields" TEXT;

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
    "claIclaRequireSignature" BOOLEAN NOT NULL DEFAULT true,
    "claIclaCustomFields" TEXT NOT NULL DEFAULT '[]',
    "claCclaCustomFields" TEXT NOT NULL DEFAULT '[]',
    "dcoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("applicationRequired", "bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "claAutoVersionRequiresResign", "claCorporateEnabled", "claEnabled", "claPlacementEmbed", "claPlacementStandalone", "claRequired", "cooldownDays", "createdAt", "currentCclaVersionId", "currentIclaVersionId", "dcoEnabled", "description", "formSchema", "id", "labelApproved", "labelClaPending", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "minCclaVersion", "minIclaVersion", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "requireApprovalCount", "slug", "templateId", "trackWhenDisabled", "updatedAt") SELECT "applicationRequired", "bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "claAutoVersionRequiresResign", "claCorporateEnabled", "claEnabled", "claPlacementEmbed", "claPlacementStandalone", "claRequired", "cooldownDays", "createdAt", "currentCclaVersionId", "currentIclaVersionId", "dcoEnabled", "description", "formSchema", "id", "labelApproved", "labelClaPending", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "minCclaVersion", "minIclaVersion", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "requireApprovalCount", "slug", "templateId", "trackWhenDisabled", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

