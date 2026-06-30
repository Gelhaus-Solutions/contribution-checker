import "server-only";
import { Client, Connection } from "@temporalio/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { clientConnectionOptions } from "./connection";

/**
 * Process-wide Temporal client singleton, cached on globalThis the same way the
 * Prisma client is (src/lib/db.ts) so Next.js HMR in dev doesn't open a new gRPC
 * connection on every reload. Used by API routes and server actions to
 * start/signal workflows. The connect is lazy and memoized via an in-flight
 * promise so concurrent callers share one connection.
 */
const globalForTemporal = globalThis as unknown as {
  temporalClient?: Promise<Client>;
};

async function connect(): Promise<Client> {
  const opts = await clientConnectionOptions();
  const connection = await Connection.connect(opts);
  logger.info(
    { address: opts.address, namespace: env.TEMPORAL_NAMESPACE },
    "temporal client connected"
  );
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
}

export function getTemporalClient(): Promise<Client> {
  if (!globalForTemporal.temporalClient) {
    globalForTemporal.temporalClient = connect().catch((e) => {
      // Reset so the next caller retries instead of caching a failed connect.
      globalForTemporal.temporalClient = undefined;
      throw e;
    });
  }
  return globalForTemporal.temporalClient;
}
