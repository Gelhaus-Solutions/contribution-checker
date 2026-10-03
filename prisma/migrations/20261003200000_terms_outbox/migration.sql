-- GPlatform Terms' outbox (GPLATTERMS-43): every account push and every
-- acceptance @ghub/terms-client sends is written here first, so nothing is lost
-- while the service is away. The table is the client's own OUTBOX_TABLE_SQL.
CREATE TABLE "terms_outbox" (
    "seq" BIGSERIAL NOT NULL,
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,

    CONSTRAINT "terms_outbox_pkey" PRIMARY KEY ("seq")
);

CREATE UNIQUE INDEX "terms_outbox_id_key" ON "terms_outbox"("id");

CREATE INDEX "terms_outbox_account" ON "terms_outbox"("surface", "account_id", "seq");

CREATE INDEX "terms_outbox_due" ON "terms_outbox"("next_attempt_at");
