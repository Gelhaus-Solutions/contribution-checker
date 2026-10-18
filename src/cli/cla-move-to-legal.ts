/**
 * Moves a project's CLA records to GPlatform Legal (GPLATLEGAL-61, D123), from
 * a shell in the running container:
 *
 *   node dist/cla-move-to-legal.mjs --project <Project.id> [--execute]
 *
 * Needs GPTERMS_URL and GPTERMS_API_KEY, as the terms step does. Without
 * --execute it only counts what it would send. Safe to run again; a project
 * already moved is left alone. The report is JSON on stdout. See
 * src/lib/cla/move-to-legal.ts for what it does and why signing never stops.
 */
import { parseArgs } from "node:util";
import { moveClaToLegal } from "@/lib/cla/move-to-legal";
import { prisma } from "@/lib/db";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    execute: { type: "boolean", default: false },
  },
});

async function main(): Promise<number> {
  if (!values.project) {
    console.error("--project is required; see the header of src/cli/cla-move-to-legal.ts");
    return 2;
  }
  const report = await moveClaToLegal(values.project, { dryRun: !values.execute });
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
