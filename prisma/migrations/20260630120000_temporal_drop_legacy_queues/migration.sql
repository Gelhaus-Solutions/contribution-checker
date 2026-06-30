-- Temporal migration: the outbound-webhook delivery queue and the unused
-- in-process job queue are replaced by durable Temporal workflows. Dropping the
-- tables also drops their foreign keys and indexes. ProcessedWebhookDelivery
-- (inbound idempotency) and ProjectWebhook (endpoint config) are intentionally
-- kept.

-- DropTable: outbound delivery rows are now owned by the
-- `outboundWebhookDelivery` workflow (Temporal history is the source of truth).
DROP TABLE IF EXISTS "WebhookDelivery";

-- DropTable: the JobQueue stub was never written to; all background work is now
-- Temporal workflows.
DROP TABLE IF EXISTS "JobQueue";
