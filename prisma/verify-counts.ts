/**
 * Standalone row-count verifier for the SQLite -> PostgreSQL migration.
 *
 * Compares per-model row counts between the legacy SQLite database (READER)
 * and the new PostgreSQL database (WRITER / default @prisma/client). Exits
 * non-zero if any model's counts differ. Safe to run any number of times.
 *
 * Run with:
 *   SQLITE_READER_URL='file:/abs/path/to/prisma/data/contribution-checker.db' \
 *     pnpm exec tsx prisma/verify-counts.ts
 */

import { PrismaClient as WriterClient } from "@prisma/client";
import { PrismaClient as ReaderClient } from "../node_modules/.prisma/sqlite-reader-client";

// Same explicit model list as the migration script, in the same order, so the
// verification surface is auditable and identical.
const MODELS: ReadonlyArray<{ model: string; delegate: string }> = [
  { model: "VerificationToken", delegate: "verificationToken" },
  { model: "RateLimitBucket", delegate: "rateLimitBucket" },
  { model: "ProcessedWebhookDelivery", delegate: "processedWebhookDelivery" },
  { model: "JobQueue", delegate: "jobQueue" },
  { model: "User", delegate: "user" },
  { model: "Account", delegate: "account" },
  { model: "Session", delegate: "session" },
  { model: "Notification", delegate: "notification" },
  { model: "FormTemplate", delegate: "formTemplate" },
  { model: "Project", delegate: "project" },
  { model: "ProjectWebhook", delegate: "projectWebhook" },
  { model: "ManualDecision", delegate: "manualDecision" },
  { model: "ProjectMember", delegate: "projectMember" },
  { model: "Repo", delegate: "repo" },
  { model: "Application", delegate: "application" },
  { model: "ApplicationReview", delegate: "applicationReview" },
  { model: "ApplicationNote", delegate: "applicationNote" },
  { model: "PrCheck", delegate: "prCheck" },
  { model: "PrQuality", delegate: "prQuality" },
  { model: "AuditEvent", delegate: "auditEvent" },
  { model: "WebhookDelivery", delegate: "webhookDelivery" },
  { model: "ClaDocumentVersion", delegate: "claDocumentVersion" },
  { model: "ClaSignature", delegate: "claSignature" },
  { model: "CorporateCla", delegate: "corporateCla" },
  { model: "CclaRosterMember", delegate: "cclaRosterMember" },
  { model: "ClaWaiver", delegate: "claWaiver" },
  { model: "ClaEventLog", delegate: "claEventLog" },
];

type Countable = { count: (args?: unknown) => Promise<number> };

function countDelegate(
  client: ReaderClient | WriterClient,
  name: string,
): Countable {
  const d = (client as unknown as Record<string, unknown>)[name];
  if (!d) throw new Error(`Prisma client has no delegate "${name}".`);
  return d as Countable;
}

const reader = new ReaderClient();
const writer = new WriterClient();

async function main(): Promise<void> {
  if (!process.env.SQLITE_READER_URL) {
    throw new Error(
      "SQLITE_READER_URL is not set. Point it at the legacy SQLite file.",
    );
  }

  let ok = true;
  for (const { model, delegate } of MODELS) {
    const [srcCount, dstCount] = await Promise.all([
      countDelegate(reader, delegate).count(),
      countDelegate(writer, delegate).count(),
    ]);
    const match = srcCount === dstCount;
    if (!match) ok = false;
    console.log(
      `${match ? "OK  " : "FAIL"} ${model}: source=${srcCount} target=${dstCount}`,
    );
  }

  // The ApplicationNote.parentId self-FK is copied in a deferred second pass by
  // the migration script, so a count match alone does not prove it was
  // reproduced. Compare the number of rows carrying a (non-null) parentId.
  const [srcLinked, dstLinked] = await Promise.all([
    countDelegate(reader, "applicationNote").count({
      where: { parentId: { not: null } },
    }),
    countDelegate(writer, "applicationNote").count({
      where: { parentId: { not: null } },
    }),
  ]);
  const linkedMatch = srcLinked === dstLinked;
  if (!linkedMatch) ok = false;
  console.log(
    `${linkedMatch ? "OK  " : "FAIL"} ApplicationNote.parentId (linked rows): source=${srcLinked} target=${dstLinked}`,
  );

  if (!ok) {
    throw new Error("Row count mismatch. See FAIL lines above.");
  }
  console.log("\nAll row counts match.");
}

main()
  .catch((err) => {
    console.error("\nVerification FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([reader.$disconnect(), writer.$disconnect()]);
  });
