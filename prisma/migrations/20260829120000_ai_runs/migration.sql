-- AI features, backed by OpenRouter.
--
-- Four surfaces (application triage, PR/QA summaries, the release narrative and
-- an AI quality signal) share exactly one table. `subjectKey` is a namespaced
-- string rather than a foreign key, so a fifth task needs no migration, the same
-- bargain `ALL_HEURISTICS` and `DIGEST_SECTIONS` already make for their catalogs.
--
-- The unique index at the bottom is the load-bearing part and does two jobs.
--
--   1. Content-hash dedupe. `inputHash` covers the task id, the prompt version,
--      the model and the normalized payload, so asking the same question twice
--      costs one call. Editing a prompt or switching model changes the hash,
--      which is why there is no invalidation logic anywhere: a stale answer is
--      not overwritten, it simply stops being found.
--
--   2. The concurrency claim. A run INSERTs its RUNNING row before calling the
--      model, so two people clicking at once means one insert wins and the other
--      reads the winner's row. PrQuality does the same thing for its warning
--      comment with an atomic `updateMany` on `warnCommentedAt`; here the
--      database constraint expresses it directly, which is both cheaper and
--      harder to get wrong.
--
-- Everything is off by default. `aiEnabled` is deliberately independent of
-- `qualityEnabled` and `checkerEnabled`: turning the gate on must never start
-- spending somebody's money, and `aiAutoRun` stays off so that until an admin
-- opts in, every call is a person pressing a button.

ALTER TABLE "Project" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "aiAutoRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "aiConfig" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "AiResult" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "output" TEXT,
    -- Kept only when validation failed. A prompt that has started drifting is
    -- otherwise undebuggable, and there is no reason to store it once the answer
    -- parsed cleanly.
    "rawOutput" TEXT,
    "error" TEXT,
    "modelId" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    -- Prompt tokens served from the provider cache, billed at roughly a tenth of
    -- fresh input. The number that says whether the stable prompt prefix pays.
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    -- Millionths of a dollar, computed locally from the published rate card.
    -- Indicative only: a BYOK key bills the upstream provider directly, and
    -- OpenRouter reports zero cost for those calls.
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    -- Null means an automatic run rather than a person.
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiResult_taskId_subjectKey_inputHash_key"
    ON "AiResult"("taskId", "subjectKey", "inputHash");

-- Serves the per-project spend and history views.
CREATE INDEX "AiResult_projectId_taskId_createdAt_idx"
    ON "AiResult"("projectId", "taskId", "createdAt");

-- Serves the render path: "the latest good answer about this subject".
CREATE INDEX "AiResult_subjectKey_status_idx" ON "AiResult"("subjectKey", "status");

ALTER TABLE "AiResult" ADD CONSTRAINT "AiResult_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The run outlives the person who triggered it: deleting a user must not delete
-- the record of what the project spent.
ALTER TABLE "AiResult" ADD CONSTRAINT "AiResult_triggeredById_fkey"
    FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
