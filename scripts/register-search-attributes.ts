/**
 * Register the custom Search Attributes (src/lib/temporal/search-attributes.ts)
 * on the Temporal namespace. Run once per namespace BEFORE deploying a worker
 * that upserts them:
 *
 *   pnpm temporal:register-sa
 *
 * Idempotent: lists the namespace's existing custom attributes and adds only
 * the missing ones (addSearchAttributes errors if ANY requested attribute
 * already exists, so a blind add is not re-runnable). A type mismatch on an
 * existing name is reported and fails the run; renaming/re-typing a registered
 * attribute is a manual operator action.
 *
 * Deploy-phase script by design (like `prisma migrate deploy`), NOT worker
 * startup: registration is a namespace-level operator mutation and racing it
 * across worker replicas is noise. Standalone tsx script convention: reads
 * TEMPORAL_* from the environment (.env.local/.env via dotenv); TLS values may
 * be a PEM file path or inline PEM text, matching src/lib/temporal/connection.ts.
 * Vault-stored certs are not resolved here; export them into the environment
 * for this script.
 */
import { readFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { Connection } from "@temporalio/client";
import { SEARCH_ATTRIBUTE_REGISTRATIONS } from "../src/lib/temporal/search-attributes";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

/** temporal.api.enums.v1.IndexedValueType values for the raw operator call. */
const INDEXED_VALUE_TYPE: Record<string, number> = {
  TEXT: 1,
  KEYWORD: 2,
  INT: 3,
  DOUBLE: 4,
  BOOL: 5,
  DATETIME: 6,
  KEYWORD_LIST: 7,
};

async function resolvePem(value: string): Promise<Buffer> {
  const looksLikePem = value.includes("-----BEGIN");
  if (!looksLikePem && value.startsWith("/")) return readFile(value.trim());
  return Buffer.from(value);
}

async function connect(): Promise<Connection> {
  const address = `${process.env.TEMPORAL_HOST ?? "localhost"}:${
    process.env.TEMPORAL_PORT ?? "7233"
  }`;
  if (process.env.TEMPORAL_TLS_ENABLED !== "true") {
    return Connection.connect({ address });
  }
  const cert = process.env.TEMPORAL_TLS_CERT;
  const key = process.env.TEMPORAL_TLS_KEY;
  if (!cert || !key) {
    throw new Error(
      "TEMPORAL_TLS_ENABLED=true but TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY are unset"
    );
  }
  const ca = process.env.TEMPORAL_TLS_CA;
  return Connection.connect({
    address,
    tls: {
      clientCertPair: { crt: await resolvePem(cert), key: await resolvePem(key) },
      serverRootCACertificate: ca ? await resolvePem(ca) : undefined,
      serverNameOverride: process.env.TEMPORAL_TLS_SERVER_NAME || undefined,
    },
  });
}

async function main(): Promise<void> {
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const connection = await connect();
  try {
    const existing = await connection.operatorService.listSearchAttributes({
      namespace,
    });
    const current = existing.customAttributes ?? {};

    const missing: Record<string, number> = {};
    for (const { name, type } of SEARCH_ATTRIBUTE_REGISTRATIONS) {
      const wanted = INDEXED_VALUE_TYPE[type];
      if (wanted == null) throw new Error(`unmapped attribute type: ${type}`);
      const got = current[name];
      if (got == null) {
        missing[name] = wanted;
      } else if (Number(got) !== wanted) {
        throw new Error(
          `search attribute ${name} already registered with type ${got}, wanted ${wanted} (${type}); fix manually`
        );
      }
    }

    if (Object.keys(missing).length === 0) {
      console.log(
        `[register-sa] namespace "${namespace}": all ${SEARCH_ATTRIBUTE_REGISTRATIONS.length} attributes already registered`
      );
      return;
    }

    await connection.operatorService.addSearchAttributes({
      namespace,
      searchAttributes: missing,
    });
    console.log(
      `[register-sa] namespace "${namespace}": registered ${Object.keys(missing).join(", ")}`
    );
  } finally {
    await connection.close();
  }
}

main().catch((e) => {
  console.error("[register-sa] failed:", e);
  process.exit(1);
});
