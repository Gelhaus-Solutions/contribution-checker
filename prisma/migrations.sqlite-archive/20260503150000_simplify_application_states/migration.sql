-- AlterTable: add denial controls
ALTER TABLE "Application" ADD COLUMN "allowResubmit" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Application" ADD COLUMN "cooldownUntil" DATETIME;

-- Snapshot cooldownUntil for existing denied-with-cooldown rows so behavior
-- doesn't change for in-flight cooldowns. SQLite computes the date by adding
-- the project's cooldownDays to the application's decidedAt.
UPDATE "Application"
   SET "cooldownUntil" = datetime(
         "decidedAt",
         '+' || (SELECT "cooldownDays" FROM "Project" WHERE "Project"."id" = "Application"."projectId") || ' days'
       )
 WHERE "status" = 'DENIED'
   AND "decidedAt" IS NOT NULL
   AND (SELECT "cooldownDays" FROM "Project" WHERE "Project"."id" = "Application"."projectId") IS NOT NULL;

-- Collapse REVOKED into DENIED with no resubmit (matches today's "admin must reset" behavior).
UPDATE "Application"
   SET "status" = 'DENIED',
       "allowResubmit" = 0,
       "cooldownUntil" = NULL
 WHERE "status" = 'REVOKED';
