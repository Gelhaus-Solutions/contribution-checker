-- CreateTable
CREATE TABLE "ProcessedWebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProcessedWebhookDelivery_createdAt_idx" ON "ProcessedWebhookDelivery"("createdAt");
