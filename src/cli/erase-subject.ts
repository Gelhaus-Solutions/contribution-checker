/**
 * Erasure on request, from a shell in the running container:
 *
 *   node dist/erase-subject.mjs --gh-login <login> [--email <address>] \
 *     --categories account,applications,prChecks,aiResults,auditEvents \
 *     --request-ref <ref> [--keep-denial-records] [--execute]
 *
 * Without --execute it only reports what would go and what would stay. The
 * report is JSON on stdout. Bundled by scripts/build-worker.mjs like the worker,
 * for the same ESM reasons; the logic is src/lib/account-erasure.ts.
 */
import { parseArgs } from "node:util";
import { eraseSubject, type ErasureCategory } from "@/lib/account-erasure";
import { prisma } from "@/lib/db";

const { values } = parseArgs({
  options: {
    "gh-login": { type: "string" },
    email: { type: "string" },
    categories: { type: "string" },
    "request-ref": { type: "string" },
    "keep-denial-records": { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
  },
});

async function main(): Promise<number> {
  if (!values.categories || !values["request-ref"]) {
    console.error("--categories and --request-ref are required; see the header of src/cli/erase-subject.ts");
    return 2;
  }
  const report = await eraseSubject(
    { ghLogin: values["gh-login"] ?? null, email: values.email ?? null },
    {
      categories: values.categories.split(",").map((c) => c.trim()).filter(Boolean) as ErasureCategory[],
      keepDenialRecords: values["keep-denial-records"] ?? false,
      requestRef: values["request-ref"],
      execute: values.execute ?? false,
    },
  );
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
