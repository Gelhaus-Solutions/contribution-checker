/**
 * Step 3 of GPID's runbook for leaving Hexclave (GPlatform, sso/docs/migration.md):
 * give every imported account its GPID subject, from the subject map GPID's
 * import printed.
 *
 *   pnpm db:backfill:sso-subjects subjects.json            # apply
 *   DRY_RUN=1 pnpm db:backfill:sso-subjects subjects.json  # report only, no writes
 *
 * The map is `{ format: "gpsso.subject-map.v1", application, subjects }`, with
 * `subjects` from the old Hexclave user id to the new pairwise subject. It is
 * keyed here on `User.stackUserId`, the Hexclave id this app kept. Do not
 * regenerate the map: the subject belongs to the GPID app account, and a
 * second import would hand out different ones.
 *
 * Idempotent: a row already holding its subject is counted and left alone. A
 * row holding a different subject, or a subject another row already holds, is
 * reported and not written, because resolving it would merge two people.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

type SubjectMap = { format: string; application: string; subjects: Record<string, string> };

function readMap(path: string | undefined): SubjectMap {
  if (!path) throw new Error("usage: backfill-sso-subjects <subjects.json>");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SubjectMap>;
  if (parsed.format !== "gpsso.subject-map.v1" || typeof parsed.subjects !== "object" || parsed.subjects === null) {
    throw new Error(`${path} is not a gpsso.subject-map.v1 file`);
  }
  if (parsed.application !== "contribution-checker") {
    throw new Error(`${path} maps subjects for "${String(parsed.application)}", not contribution-checker`);
  }
  return parsed as SubjectMap;
}

async function main(): Promise<void> {
  const map = readMap(process.argv[2]);
  const dryRun = process.env.DRY_RUN === "1";
  const prisma = new PrismaClient();
  const counts = { written: 0, already: 0, noRow: 0, conflicts: 0 };
  try {
    for (const [stackUserId, subject] of Object.entries(map.subjects)) {
      const row = await prisma.user.findUnique({
        where: { stackUserId },
        select: { id: true, ssoSubject: true },
      });
      if (!row) {
        counts.noRow += 1;
        console.warn(`no local account for Hexclave user ${stackUserId}`);
        continue;
      }
      if (row.ssoSubject === subject) {
        counts.already += 1;
        continue;
      }
      const holder = await prisma.user.findUnique({ where: { ssoSubject: subject }, select: { id: true } });
      if (row.ssoSubject !== null || (holder && holder.id !== row.id)) {
        counts.conflicts += 1;
        console.warn(`conflict for account ${row.id}: it holds ${String(row.ssoSubject)}, the map says ${subject}`);
        continue;
      }
      if (!dryRun) await prisma.user.update({ where: { id: row.id }, data: { ssoSubject: subject } });
      counts.written += 1;
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `${dryRun ? "[dry-run] would write" : "wrote"} ${counts.written}; already set ${counts.already}; ` +
      `no local account ${counts.noRow}; conflicts ${counts.conflicts}`,
  );
  if (counts.conflicts > 0) process.exitCode = 1;
}

void main();
