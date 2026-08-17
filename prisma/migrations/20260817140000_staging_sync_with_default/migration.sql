-- Keep the staging branch current with the default branch, with no PR.
--
-- Without this, a staging branch only ever moves when something merges into
-- it, so a default branch that keeps advancing leaves staging behind and every
-- contributor retargeted onto it gets a stale base.
--
-- Defaults to true rather than false: it is inert unless the project already
-- has retargeting or the aggregate PR switched on (both of which default to
-- false), so the default cannot touch a repo that is not using staging
-- routing, and anyone who has switched staging routing on wants staging to
-- track the default branch.
ALTER TABLE "Project" ADD COLUMN "stagingSyncEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Nullable on Repo, as with the other two overrides: NULL means inherit.
ALTER TABLE "Repo" ADD COLUMN "stagingSyncEnabled" BOOLEAN;
