-- A project's CLA records can move to GPlatform Legal (GPLATLEGAL-61, D123):
-- when they did, every CLA read and write of the project goes there.
ALTER TABLE "Project" ADD COLUMN "claLegalEnrolledAt" TIMESTAMP(3);

-- A signature has more than one ledger entry once it is revoked (its
-- `icla.signed` and its `signature.revoked` both name it), so the link is an
-- index, not a unique key: as unique, every revocation failed on it.
DROP INDEX "ClaEventLog_signatureId_key";
CREATE INDEX "ClaEventLog_signatureId_idx" ON "ClaEventLog"("signatureId");
