-- Remember which PRs the bot moved onto staging, and what they were based on
-- before it did.
--
-- This is what makes the staging opt-out label work after the fact: labelling
-- a PR that is already on staging repoints it at `fromBase`, while a PR the
-- bot never touched (opened against staging on purpose, or moved there by a
-- maintainer) is left alone. Without the record the only available test is
-- "the base is staging", which would quietly retarget those PRs down to the
-- default branch: a release, not a routing change.
--
-- Deliberately its own table rather than a column on PrCheck: retargeting runs
-- before the gate, so on `pull_request.opened` there is no PrCheck row to
-- write to yet, and with the checker disabled and trackWhenDisabled off there
-- never will be.
CREATE TABLE "StagingRetarget" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "fromBase" TEXT NOT NULL,
    "toBase" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagingRetarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StagingRetarget_repoId_prNumber_key" ON "StagingRetarget"("repoId", "prNumber");

ALTER TABLE "StagingRetarget" ADD CONSTRAINT "StagingRetarget_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
