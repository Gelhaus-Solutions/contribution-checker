-- AlterTable: link a local User to its Hexclave (Stack Auth) user, and store
-- the onboarding country code (ISO 3166-1 alpha-2). Both are additive and
-- nullable so the migration is safe to apply before the auth cutover.
ALTER TABLE "User" ADD COLUMN "stackUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "country" TEXT;

-- CreateIndex: stackUserId is the lookup key for resolving a session to a local
-- User row, and must be unique (one local row per Hexclave user).
CREATE UNIQUE INDEX "User_stackUserId_key" ON "User"("stackUserId");
