-- AlterTable: link a local User to its GPID (GPlatform SSO) subject, the
-- first step of the move off Hexclave. Additive and nullable, so it is safe to
-- apply before the auth swap: nothing reads it until then.
ALTER TABLE "User" ADD COLUMN "ssoSubject" TEXT;

-- CreateIndex: ssoSubject is the lookup key for resolving a GPID session to a
-- local User row, and must be unique (one local row per GPID subject).
CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");
