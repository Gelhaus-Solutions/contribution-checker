-- CreateTable: ProjectWebhook
CREATE TABLE "ProjectWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectWebhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Migrate any existing single-webhook configuration into ProjectWebhook.
-- We synthesize an id with lower(hex(randomblob())) so this migration does
-- not depend on an external runtime.
INSERT INTO "ProjectWebhook" ("id", "projectId", "name", "kind", "url", "secret", "enabled", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(12))),
    "id",
    NULL,
    'generic',
    "webhookUrl",
    "webhookSecret",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Project"
WHERE "webhookUrl" IS NOT NULL AND "webhookUrl" <> '';

-- CreateIndex
CREATE INDEX "ProjectWebhook_projectId_idx" ON "ProjectWebhook"("projectId");

-- AlterTable: drop legacy webhookUrl/webhookSecret on Project (SQLite rebuild)
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "slug", "templateId", "trackWhenDisabled", "updatedAt") SELECT "bypassCollabs", "bypassHandles", "checkerEnabled", "checksEnabled", "cooldownDays", "createdAt", "description", "formSchema", "id", "labelApproved", "labelDenied", "labelEvaluate", "labelPending", "labelsEnabled", "name", "prTemplateHoneypots", "qualityCommentMin", "qualityConfig", "qualityEnabled", "slug", "templateId", "trackWhenDisabled", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- AlterTable: WebhookDelivery -- add endpointId + kind
ALTER TABLE "WebhookDelivery" ADD COLUMN "endpointId" TEXT REFERENCES "ProjectWebhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'generic';
