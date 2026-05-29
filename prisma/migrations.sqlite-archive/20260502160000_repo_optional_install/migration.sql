-- RedefineTables: make Repo.ghRepoId and Repo.installationId nullable, add (projectId, fullName) unique
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "ghRepoId" INTEGER,
    "fullName" TEXT NOT NULL,
    "installationId" INTEGER,
    "requireOwnApproval" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Repo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Repo" ("id", "projectId", "ghRepoId", "fullName", "installationId", "requireOwnApproval", "active", "createdAt")
SELECT "id", "projectId", "ghRepoId", "fullName", "installationId", "requireOwnApproval", "active", "createdAt"
FROM "Repo";

DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";

CREATE UNIQUE INDEX "Repo_ghRepoId_key" ON "Repo"("ghRepoId");
CREATE UNIQUE INDEX "Repo_projectId_fullName_key" ON "Repo"("projectId", "fullName");
CREATE INDEX "Repo_projectId_idx" ON "Repo"("projectId");

PRAGMA foreign_keys=ON;
