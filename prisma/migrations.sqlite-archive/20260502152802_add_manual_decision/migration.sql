-- CreateTable
CREATE TABLE "ManualDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "ghLogin" TEXT NOT NULL,
    "ghId" INTEGER,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "decidedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ManualDecision_ghId_idx" ON "ManualDecision"("ghId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualDecision_projectId_ghLogin_key" ON "ManualDecision"("projectId", "ghLogin");
