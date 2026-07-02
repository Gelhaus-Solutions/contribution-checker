/**
 * Register the custom Search Attributes (src/lib/temporal/search-attributes.ts)
 * on the Temporal namespace:
 *
 *   pnpm temporal:register-sa
 *
 * The worker also self-registers these at startup (src/worker/run.ts), so on a
 * self-hosted cluster this script is optional: use it to pre-register before
 * the first deploy, or to verify a namespace from CI. It is REQUIRED knowledge
 * for Temporal Cloud, where the Operator API is blocked for both this script
 * and the worker: register the attributes there with `tcld` or the Cloud UI
 * instead (same names and types; see the summary this script prints).
 *
 * Idempotent and re-runnable: existing attributes are skipped, missing ones
 * are added one at a time so a single conflicted or capped name cannot block
 * the rest. A type mismatch on an existing name is reported and fails the run;
 * re-typing a registered attribute is a manual operator action
 * (delete+recreate) by design.
 *
 * Standalone tsx script convention: reads TEMPORAL_* from the environment
 * (.env.local/.env via dotenv); TLS values may be a PEM file path or inline
 * PEM text, matching src/lib/temporal/connection.ts. Vault-stored certs are
 * not resolved here; export them into the environment for this script.
 */
import { readFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { Connection } from "@temporalio/client";
import { SEARCH_ATTRIBUTE_REGISTRATIONS } from "../src/lib/temporal/search-attributes";
import {
  ensureSearchAttributes,
  indexedValueTypeName,
} from "../src/lib/temporal/search-attribute-registration";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

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
    const res = await ensureSearchAttributes(
      connection.operatorService,
      namespace
    );

    if (res.added.length > 0) {
      console.log(
        `[register-sa] namespace "${namespace}": registered ${res.added.join(", ")}`
      );
    }
    if (res.added.length === 0 && res.mismatched.length === 0 && res.failed.length === 0) {
      console.log(
        `[register-sa] namespace "${namespace}": all ${SEARCH_ATTRIBUTE_REGISTRATIONS.length} attributes already registered`
      );
    }
    for (const m of res.mismatched) {
      console.error(
        `[register-sa] ${m.name} already registered with type ${indexedValueTypeName(
          m.registered
        )}, wanted ${indexedValueTypeName(m.wanted)}; fix manually (delete+recreate on the namespace, or rename in code)`
      );
    }
    for (const f of res.failed) {
      console.error(`[register-sa] failed to register ${f.name}:`, f.error);
    }
    if (res.mismatched.length > 0 || res.failed.length > 0) {
      process.exit(1);
    }
  } finally {
    await connection.close();
  }
}

main().catch((e) => {
  console.error("[register-sa] failed:", e);
  process.exit(1);
});
