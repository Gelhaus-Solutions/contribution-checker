/**
 * GLockdown from a shell in the running container (src/lib/lockdown.ts), for
 * when the console at /admin/lockdown is out of reach: at `full` nobody signs
 * in, super-admins included.
 *
 *   node dist/glockdown.mjs status           the stage, its sources, the identity, the decoys
 *   node dist/glockdown.mjs ask              the edge's answer, now
 *   node dist/glockdown.mjs escalate --reason "suspicious sign-ins"
 *   node dist/glockdown.mjs report-decoys    the decoy inventory, now
 *   node dist/glockdown.mjs pin              this app's pin for the trust document
 *   node dist/glockdown.mjs hash-key < file  the SHA-256 to set in GLOCKDOWN_DECOY_KEY_SHA256
 *
 * Output is JSON on stdout (hash-key and pin print the bare value). Raises and
 * reports are audited like the console's, with no actor. Nothing here lowers
 * a stage. hash-key reads the key from stdin so it never lands in the shell's
 * history, and it is the only command that sees a key at all.
 */
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { prisma } from "@/lib/db";
import {
  askEdgeNow,
  decoyFingerprints,
  inspectIdentity,
  lockdownStatus,
  raiseOneRung,
  refreshFromEdge,
  reportDecoyInventory,
} from "@/lib/lockdown";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reason: { type: "string" } },
});

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  switch (positionals[0]) {
    case "status": {
      // A fresh process has not heard from the edge yet: ask before reading.
      await refreshFromEdge();
      const fp = decoyFingerprints();
      print({
        ...lockdownStatus(),
        identity: inspectIdentity(),
        fingerprints: fp,
      });
      return 0;
    }
    case "ask": {
      const answer = await askEdgeNow(10_000);
      print(answer);
      return answer.asked && answer.ok ? 0 : 1;
    }
    case "escalate": {
      if (!values.reason?.trim()) {
        console.error('escalate needs --reason "...": GLockdown records it with the raise');
        return 2;
      }
      await refreshFromEdge();
      const outcome = await raiseOneRung({ reason: values.reason, actorId: null, via: "cli" });
      print(outcome);
      return outcome.ok ? 0 : 1;
    }
    case "report-decoys": {
      const r = await reportDecoyInventory("cli");
      print(r);
      return r.ok ? 0 : 1;
    }
    case "pin": {
      const identity = inspectIdentity();
      if (!identity.certificate) {
        console.error(identity.problem);
        return 1;
      }
      console.log(identity.certificate.pin);
      return 0;
    }
    case "hash-key": {
      // One trailing newline is the file's or the echo's, not the key's.
      const key = (await readStdin()).replace(/\r?\n$/, "");
      if (!key) {
        console.error("hash-key reads the decoy key from stdin");
        return 2;
      }
      console.log(createHash("sha256").update(key, "utf8").digest("hex"));
      return 0;
    }
    default:
      console.error(
        "usage: glockdown.mjs status | ask | escalate --reason <text> | report-decoys | pin | hash-key < key",
      );
      return 2;
  }
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
