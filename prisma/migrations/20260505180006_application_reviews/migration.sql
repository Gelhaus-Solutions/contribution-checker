-- Adds the PR-style review system on top of ApplicationNote: per-field
-- comments, threaded replies, applicant-visible flag, soft-delete, and a
-- new ApplicationReview row that bundles a reviewer's comments under one
-- state (Approve / Request Changes / Comment). Adds a per-project knob
-- (Project.requireApprovalCount) that gates the approve action behind
-- distinct-author LGTMs.
--
-- Existing ApplicationNote rows: backfilled with updatedAt = createdAt
-- and visibility = INTERNAL (current behavior).

-- CreateTable
CREATE TABLE "ApplicationReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "body" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'INTERNAL',
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ApplicationReview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationReview_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApplicationNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "reviewId" TEXT,
    "parentId" TEXT,
    "fieldId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'INTERNAL',
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ApplicationNote_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApplicationNote_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ApplicationReview" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApplicationNote_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ApplicationNote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApplicationNote" ("applicationId", "authorId", "body", "createdAt", "updatedAt", "id") SELECT "applicationId", "authorId", "body", "createdAt", "createdAt", "id" FROM "ApplicationNote";
DROP TABLE "ApplicationNote";
ALTER TABLE "new_ApplicationNote" RENAME TO "ApplicationNote";
CREATE INDEX "ApplicationNote_applicationId_fieldId_idx" ON "ApplicationNote"("applicationId", "fieldId");
CREATE INDEX "ApplicationNote_reviewId_idx" ON "ApplicationNote"("reviewId");
CREATE INDEX "ApplicationNote_parentId_idx" ON "ApplicationNote"("parentId");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "slug", "templateId", "trackWhenDisabled", "updatedAt") SELECT "bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "qualityTemplateMatchPct", "slug", "templateId", "trackWhenDisabled", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ApplicationReview_applicationId_state_idx" ON "ApplicationReview"("applicationId", "state");

-- CreateIndex
CREATE INDEX "ApplicationReview_authorId_idx" ON "ApplicationReview"("authorId");
