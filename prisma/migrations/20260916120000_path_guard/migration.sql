-- A fourth Check Run: "contribution-checker / guard".
--
-- Branch protection can require a review on every PR. It cannot require one
-- only when a migration, a Temporal workflow or a CI definition is in the diff,
-- and it cannot require that the review come from a named person. So a change
-- that runs against production on deploy lands through the same gate as a
-- README typo.
--
-- The guard fails when a PR based on the DEFAULT branch changes files matching
-- the project's guarded path rules, and passes once a configured approver has
-- approved the PR or added the unlock label. Off by default; a project that
-- never turns it on publishes no check at all, which is the fourth state the
-- other three checks already have (absent, not `skipped`).
--
-- Everything here is additive with a default, so existing rows are correct as
-- they stand and no backfill is needed.

-- ----- Project: the configuration -----
--
-- Project-level only, with no per-repo overrides. The six staging columns on
-- Repo exist because retargeting genuinely differs per repo; a rule about
-- whether migrations need sign-off is a rule about the project.
--
-- guardRules is read permissive-OPEN (unreadable means every rule on) while
-- guardGlobs and guardApprovers are permissive-closed. Both directions point
-- the same way: a corrupt rule list must not stop guarding, and a corrupt
-- approver list must not start handing out unlocks to logins nobody
-- configured.
ALTER TABLE "Project" ADD COLUMN "guardEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "guardRules" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Project" ADD COLUMN "guardGlobs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Project" ADD COLUMN "guardApprovers" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Project" ADD COLUMN "guardUnlockMode" TEXT NOT NULL DEFAULT 'either';

-- Both labels live OUTSIDE the `contribution:` namespace, for the reason the
-- staging labels do: setLabels() owns that namespace and strips every
-- `contribution:*` label the gate did not just set, so a guard label placed
-- there would be wiped by the next converge.
ALTER TABLE "Project" ADD COLUMN "labelGuardUnlock" TEXT NOT NULL DEFAULT 'guard:approved';
ALTER TABLE "Project" ADD COLUMN "labelGuardBlocked" TEXT NOT NULL DEFAULT 'guard:blocked';

-- ----- PrCheck: the check run binding and the sign-off record -----
--
-- guardCheckSha is its own column rather than riding on PrCheck.headSha. A
-- check run belongs to the commit it was created against and PATCH cannot move
-- it, and convergePr (which resets checkRunId/claCheckRunId when headSha
-- advances) never runs for a `pull_request_review` event, which the guard does
-- republish on. Pairing the id with its own SHA makes reuse self-contained:
-- same rule as StagingBatch.qaCheckSha.
ALTER TABLE "PrCheck" ADD COLUMN "guardCheckRunId" TEXT;
ALTER TABLE "PrCheck" ADD COLUMN "guardCheckSha" TEXT;

-- Who signed off, and by which route ("review" | "label").
ALTER TABLE "PrCheck" ADD COLUMN "guardUnlockSource" TEXT;
ALTER TABLE "PrCheck" ADD COLUMN "guardUnlockBy" TEXT;
ALTER TABLE "PrCheck" ADD COLUMN "guardUnlockAt" TIMESTAMP(3);

-- JSON { path: blobSha } of the guarded files that were signed off.
--
-- Storing blob SHAs rather than a path list is what makes "re-require approval
-- only when guarded files changed" exact in both directions: a push touching
-- only ordinary files leaves every guarded blob where it was and keeps the
-- unlock, while one character in a guarded file changes its blob and takes the
-- unlock away. A rebase that leaves content identical produces the same blob,
-- so it does not re-block a PR nobody actually changed.
ALTER TABLE "PrCheck" ADD COLUMN "guardApprovedFiles" TEXT NOT NULL DEFAULT '{}';

-- Whether the bot's blocked marker label is currently on the PR. Tracked on the
-- row so the steady state costs no GitHub call (reconciles run on every push),
-- the same bargain qaLabelApplied makes. A failed call leaves the flag unset so
-- the next pass retries.
ALTER TABLE "PrCheck" ADD COLUMN "guardLabelApplied" BOOLEAN NOT NULL DEFAULT false;
