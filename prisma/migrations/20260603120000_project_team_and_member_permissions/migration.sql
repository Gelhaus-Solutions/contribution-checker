-- AlterTable: map each Project to its backing Hexclave (Stack Auth) team, and
-- cache each ProjectMember's effective leaf-permission set. Both are additive:
-- teamId is nullable (legacy/unmigrated projects stay valid until backfilled),
-- and permissions defaults to an empty JSON array (no behavior change until the
-- permission gate is switched on). The backfill populates both.
ALTER TABLE "Project" ADD COLUMN "teamId" TEXT;
ALTER TABLE "ProjectMember" ADD COLUMN "permissions" TEXT NOT NULL DEFAULT '[]';

-- CreateIndex: one Project = one team.
CREATE UNIQUE INDEX "Project_teamId_key" ON "Project"("teamId");
