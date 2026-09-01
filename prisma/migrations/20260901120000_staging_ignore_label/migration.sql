-- Split the one staging escape-hatch label into two, because it was answering
-- two different questions with one word.
--
-- The old `staging:opt-out` label both prevented a retarget and, applied to a
-- PR already on staging, moved that PR back off it. That second half is a
-- release decision (this must not ship in the batch) and it is not what a
-- maintainer always wants: sometimes the base is already right and the only
-- problem is the bot having an opinion about it. Asking for "stop touching
-- this" and getting the PR moved out from under you is the wrong default to
-- have no alternative to.
--
--   labelStagingRepoint -> exactly the old behavior, renamed to say so.
--   labelStagingIgnore  -> new: no retarget, no repoint, no move at all.
--
-- The rename preserves each project's configured value, so a project still
-- using the `staging:opt-out` default keeps it and the labels already sitting
-- on live PRs keep working. Only projects created from here on get
-- `staging:repoint`.
ALTER TABLE "Project" RENAME COLUMN "labelStagingOptOut" TO "labelStagingRepoint";
ALTER TABLE "Project" ALTER COLUMN "labelStagingRepoint" SET DEFAULT 'staging:repoint';

ALTER TABLE "Project" ADD COLUMN "labelStagingIgnore" TEXT NOT NULL DEFAULT 'staging:ignore';

-- A project that had already renamed its opt-out label to `staging:ignore`
-- would otherwise end up with both labels sharing one name, where the ignore
-- half silently swallows the repoint half. Two features cannot share a label:
-- the settings forms reject it, so no row is allowed to start out that way.
UPDATE "Project"
   SET "labelStagingIgnore" = 'staging:leave-alone'
 WHERE "labelStagingRepoint" = 'staging:ignore';
