/**
 * A privacy plan run by hand, from a shell in the running container, for when
 * GPlatform Terms cannot be used (the console is the normal way):
 *
 *   node dist/erase-subject.mjs --request-ref DSR-2026-10-03-1 \
 *     [--email <address>] [--gh-login <login>] [--account-id <User.id>] \
 *     --plan account=pseudonymise,applications=keep,applicationText=delete,... \
 *     [--execute]
 *
 * Every category of the catalogue needs an action (src/lib/account-erasure.ts).
 * Without --execute it only counts. The report is JSON on stdout.
 */
import { parseArgs } from "node:util";
import { runPrivacyPlan, type PrivacyAction } from "@/lib/account-erasure";
import { prisma } from "@/lib/db";

const { values } = parseArgs({
  options: {
    "gh-login": { type: "string" },
    email: { type: "string" },
    "account-id": { type: "string", multiple: true },
    plan: { type: "string" },
    "request-ref": { type: "string" },
    execute: { type: "boolean", default: false },
  },
});

async function main(): Promise<number> {
  if (!values.plan || !values["request-ref"]) {
    console.error("--plan and --request-ref are required; see the header of src/cli/erase-subject.ts");
    return 2;
  }
  const plan = Object.fromEntries(
    values.plan.split(",").map((pair) => {
      const [category, action] = pair.split("=").map((part) => part.trim());
      return [category, action as PrivacyAction];
    }),
  );
  const report = await runPrivacyPlan(
    {
      email: values.email ?? null,
      identifiers: values["gh-login"] ? { github: values["gh-login"] } : {},
      accountIds: values["account-id"] ?? [],
    },
    plan,
    { execute: values.execute ?? false, requestRef: values["request-ref"] },
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
