-- A moved project's chain in GPlatform Legal is followed (D126): Legal's staff
-- write to it too, and this instance checks the project's pull requests again
-- for an entry it did not write itself. Null: not followed yet.
ALTER TABLE "Project" ADD COLUMN "claLegalFollowedSeq" INTEGER;
