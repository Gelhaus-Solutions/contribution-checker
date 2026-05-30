/**
 * One-off SQLite -> PostgreSQL data migration.
 *
 * Reads every row from the legacy SQLite database (via a dedicated READER
 * Prisma client generated from prisma/sqlite-reader.prisma) and copies it into
 * the new PostgreSQL database (via the default @prisma/client WRITER, which is
 * now generated against the postgres datasource).
 *
 * Design notes (see the migration analysis that accompanied this script):
 *
 *  - NO type coercion. Both Prisma clients hydrate/serialize values off the
 *    SAME schema, so Boolean->boolean, DateTime->Date, Int->number,
 *    String->string round-trip end to end. JSON-string columns are declared
 *    `String` (plain TEXT); they are copied VERBATIM and must NOT be
 *    parsed/re-serialized (notably ClaEventLog.payload is a key-sorted,
 *    hash-chained snapshot whose bytes must not change).
 *
 *  - Insert order respects FKs (postgres enforces them; sqlite may not have).
 *    The order below is an explicit, auditable topological sort. Parents are
 *    inserted before children. The one subtlety is FormTemplate BEFORE Project
 *    (Project.templateId -> FormTemplate).
 *
 *  - ApplicationNote.parentId is a self-FK. We use a null-then-update strategy:
 *    PASS 1 inserts every row with parentId forced to null (the column is
 *    nullable, so no FK violation regardless of intra-table order); PASS 2
 *    restores the real parentId via per-row updates, by which point every
 *    parent target already exists.
 *
 *  - Idempotent / re-runnable. Inserts use createMany({ skipDuplicates: true })
 *    so a partial prior run can be resumed; the parentId restore pass is also
 *    naturally idempotent (it just re-sets the same value).
 *
 *  - Verification. After copying, source and target row counts are compared per
 *    model; any mismatch makes the process exit non-zero.
 *
 * Run with:
 *   SQLITE_READER_URL='file:/abs/path/to/prisma/data/contribution-checker.db' \
 *     pnpm exec tsx prisma/migrate-sqlite-to-postgres.ts
 *
 * Prereqs:
 *   1. pnpm exec prisma generate --schema=prisma/sqlite-reader.prisma
 *   2. (after repointing schema.prisma to postgres) pnpm exec prisma generate
 *   3. The postgres schema must already exist (prisma db push / migrate).
 */

import { PrismaClient as WriterClient } from "@prisma/client";
// READER client is emitted to a custom output dir by prisma/sqlite-reader.prisma
// (NOT the bare "@prisma/client" specifier, which is the postgres WRITER).
import { PrismaClient as ReaderClient } from "../node_modules/.prisma/sqlite-reader-client";

const CHUNK_SIZE = 500;

/**
 * Explicit, auditable migration order. Each entry maps a logical model name to
 * the Prisma delegate accessor used on both clients. Parents precede children;
 * FormTemplate precedes Project; CLA chain is ordered version -> signature ->
 * corporate -> roster. ApplicationNote is handled specially (self-FK) but still
 * appears here so its rows are inserted (with parentId nulled) in the right
 * slot relative to Application/ApplicationReview/User.
 *
 * `delegate` is the lowercase Prisma model accessor (e.g. prisma.applicationNote).
 * `selfRefParent` marks the model whose self-referential FK column must be
 * deferred to a second pass.
 */
const MIGRATION_ORDER: ReadonlyArray<{
  model: string;
  delegate: string;
  selfRefParent?: "parentId";
}> = [
  // Independent tables (no FK in either direction): order among these is free.
  { model: "VerificationToken", delegate: "verificationToken" },
  { model: "RateLimitBucket", delegate: "rateLimitBucket" },
  { model: "ProcessedWebhookDelivery", delegate: "processedWebhookDelivery" },
  { model: "JobQueue", delegate: "jobQueue" },

  // User is a true root (zero outgoing FKs).
  { model: "User", delegate: "user" },
  { model: "Account", delegate: "account" },
  { model: "Session", delegate: "session" },
  { model: "Notification", delegate: "notification" },

  // FormTemplate (-> User) MUST precede Project (Project.templateId -> FormTemplate).
  { model: "FormTemplate", delegate: "formTemplate" },
  { model: "Project", delegate: "project" },

  // Project children.
  { model: "ProjectWebhook", delegate: "projectWebhook" },
  { model: "ManualDecision", delegate: "manualDecision" },
  { model: "ProjectMember", delegate: "projectMember" },
  { model: "Repo", delegate: "repo" },

  // Application + its children. ApplicationReview before ApplicationNote
  // (ApplicationNote.reviewId -> ApplicationReview).
  { model: "Application", delegate: "application" },
  { model: "ApplicationReview", delegate: "applicationReview" },
  { model: "ApplicationNote", delegate: "applicationNote", selfRefParent: "parentId" },

  // PrCheck -> Repo; PrQuality 1:1 -> PrCheck.
  { model: "PrCheck", delegate: "prCheck" },
  { model: "PrQuality", delegate: "prQuality" },

  // Misc project/user children.
  { model: "AuditEvent", delegate: "auditEvent" },
  { model: "WebhookDelivery", delegate: "webhookDelivery" },

  // CLA chain: version -> signature -> corporate -> roster; waiver/log last.
  { model: "ClaDocumentVersion", delegate: "claDocumentVersion" },
  { model: "ClaSignature", delegate: "claSignature" },
  { model: "CorporateCla", delegate: "corporateCla" },
  { model: "CclaRosterMember", delegate: "cclaRosterMember" },
  { model: "ClaWaiver", delegate: "claWaiver" },
  { model: "ClaEventLog", delegate: "claEventLog" },
];

/** Minimal shape of a Prisma model delegate we rely on. */
type Delegate = {
  findMany: (args?: unknown) => Promise<Array<Record<string, unknown>>>;
  createMany: (args: {
    data: Array<Record<string, unknown>>;
    skipDuplicates?: boolean;
  }) => Promise<{ count: number }>;
  update: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  count: (args?: unknown) => Promise<number>;
};

function delegateOf(client: ReaderClient | WriterClient, name: string): Delegate {
  const d = (client as unknown as Record<string, unknown>)[name];
  if (!d) {
    throw new Error(`Prisma client has no delegate "${name}". Check MIGRATION_ORDER.`);
  }
  return d as Delegate;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const reader = new ReaderClient();
const writer = new WriterClient();

async function copyModel(entry: (typeof MIGRATION_ORDER)[number]): Promise<void> {
  const { model, delegate, selfRefParent } = entry;
  const src = delegateOf(reader, delegate);
  const dst = delegateOf(writer, delegate);

  // Plain findMany (scalars only, no `include`), so we never pass relation
  // objects to createMany and never let @default/@updatedAt/cuid()/now()
  // overwrite the original ids/timestamps. createMany writes the explicit
  // column values we read.
  const rows = await src.findMany();

  if (rows.length === 0) {
    console.log(`  ${model}: 0 rows (skip)`);
    return;
  }

  // For the self-referential model, defer parentId: insert with parentId=null
  // in pass 1 so no row can reference a not-yet-inserted parent.
  let inserted = 0;
  if (selfRefParent) {
    const deferredRows = rows.map((r) => ({ ...r, [selfRefParent]: null }));
    for (const batch of chunk(deferredRows, CHUNK_SIZE)) {
      const res = await dst.createMany({ data: batch, skipDuplicates: true });
      inserted += res.count;
    }
    console.log(
      `  ${model}: inserted ${inserted}/${rows.length} (parentId deferred to pass 2)`,
    );
  } else {
    for (const batch of chunk(rows, CHUNK_SIZE)) {
      const res = await dst.createMany({ data: batch, skipDuplicates: true });
      inserted += res.count;
    }
    console.log(`  ${model}: inserted ${inserted}/${rows.length}`);
  }

  // On a clean first run the target is empty, so every source row should
  // insert. A shortfall means skipDuplicates suppressed something: either a
  // re-run (benign) or a unique constraint postgres enforces that sqlite did
  // not (needs investigation). Surface it now rather than only at verifyCounts.
  if (inserted < rows.length) {
    console.warn(
      `  WARN ${model}: ${rows.length - inserted} row(s) skipped by ` +
        `skipDuplicates (inserted ${inserted}/${rows.length}). Expected on a ` +
        `re-run; if this is a first run, investigate a unique-constraint clash.`,
    );
  }
}

/**
 * PASS 2 for ApplicationNote: restore the real parentId now that every row
 * exists (pass 1 inserted them all with parentId nulled).
 *
 * Each update is independent and idempotent (it re-sets the same value), so the
 * updates run OUTSIDE any transaction, chunked for throughput. Do NOT wrap the
 * whole pass in one interactive `$transaction`: Prisma's default interactive-
 * transaction timeout is 5s, so a single transaction spanning hundreds of
 * threaded notes would abort with P2028 and roll back every restore, and the
 * count-only verifier would not catch the lost thread structure. An interrupted
 * pass here is safely resumed by just re-running the script.
 */
async function restoreSelfReferences(): Promise<void> {
  const src = delegateOf(reader, "applicationNote");
  const dst = delegateOf(writer, "applicationNote");
  const rows = await src.findMany();
  const withParent = rows.filter(
    (r) => r.parentId !== null && r.parentId !== undefined,
  );
  if (withParent.length === 0) {
    console.log("  ApplicationNote.parentId: 0 rows to restore");
    return;
  }

  let restored = 0;
  for (const batch of chunk(withParent, CHUNK_SIZE)) {
    await Promise.all(
      batch.map((r) =>
        dst.update({
          where: { id: r.id as string },
          data: { parentId: r.parentId as string },
        }),
      ),
    );
    restored += batch.length;
  }
  console.log(`  ApplicationNote.parentId: restored ${restored} rows`);
}

async function verifyCounts(): Promise<boolean> {
  console.log("\nVerifying row counts (source vs target)...");
  let ok = true;
  for (const { model, delegate } of MIGRATION_ORDER) {
    const [srcCount, dstCount] = await Promise.all([
      delegateOf(reader, delegate).count(),
      delegateOf(writer, delegate).count(),
    ]);
    const match = srcCount === dstCount;
    if (!match) ok = false;
    console.log(
      `  ${match ? "OK  " : "FAIL"} ${model}: source=${srcCount} target=${dstCount}`,
    );
  }

  // Row counts alone cannot prove the ApplicationNote.parentId self-FK graph
  // was reproduced: it is written in the deferred pass 2, and a partial/failed
  // restore would leave parentId NULL while counts still match. Verify it
  // explicitly by comparing the number of rows with a non-null parentId.
  const [srcLinked, dstLinked] = await Promise.all([
    delegateOf(reader, "applicationNote").count({
      where: { parentId: { not: null } },
    }),
    delegateOf(writer, "applicationNote").count({
      where: { parentId: { not: null } },
    }),
  ]);
  const linkedMatch = srcLinked === dstLinked;
  if (!linkedMatch) ok = false;
  console.log(
    `  ${linkedMatch ? "OK  " : "FAIL"} ApplicationNote.parentId (linked rows): source=${srcLinked} target=${dstLinked}`,
  );

  return ok;
}

async function main(): Promise<void> {
  if (!process.env.SQLITE_READER_URL) {
    throw new Error(
      "SQLITE_READER_URL is not set. Point it at the legacy SQLite file, e.g. " +
        "file:/abs/path/to/prisma/data/contribution-checker.db",
    );
  }

  console.log("Copying tables (parents before children)...");
  for (const entry of MIGRATION_ORDER) {
    await copyModel(entry);
  }

  console.log("\nRestoring self-references (ApplicationNote.parentId pass 2)...");
  await restoreSelfReferences();

  const ok = await verifyCounts();
  if (!ok) {
    throw new Error(
      "Row count mismatch between source and target: migration is INCOMPLETE. " +
        "See the FAIL lines above. The copy is idempotent (skipDuplicates), so " +
        "you can re-run this script after resolving the cause.",
    );
  }
  console.log("\nMigration complete. All row counts match.");
}

main()
  .catch((err) => {
    console.error("\nMigration FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([reader.$disconnect(), writer.$disconnect()]);
  });
