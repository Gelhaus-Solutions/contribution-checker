-- AlterTable: per-project opt-in for application appeals. Additive, defaults to
-- false so existing projects do not start accepting appeals until enabled.
ALTER TABLE "Project" ADD COLUMN "allowAppeals" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: a contributor's appeal of a DENIED application. One per
-- application (unique applicationId). Carries a message + revised answers; a
-- reviewer resolves it to GRANTED / RESUBMIT_ALLOWED / REJECTED.
CREATE TABLE "ApplicationAppeal" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT NOT NULL,
    "answers" TEXT NOT NULL DEFAULT '{}',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAppeal_applicationId_key" ON "ApplicationAppeal"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationAppeal_projectId_status_idx" ON "ApplicationAppeal"("projectId", "status");

-- AddForeignKey
ALTER TABLE "ApplicationAppeal" ADD CONSTRAINT "ApplicationAppeal_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationAppeal" ADD CONSTRAINT "ApplicationAppeal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationAppeal" ADD CONSTRAINT "ApplicationAppeal_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
