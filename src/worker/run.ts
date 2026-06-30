import path from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import * as activities from "./activities";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { TASK_QUEUE } from "@/lib/temporal/task-queue";
import { resolveTemporalTls, temporalAddress } from "@/lib/temporal/connection";
import { ensureSchedules } from "@/lib/temporal/schedules";
import { warmupSecrets } from "@/lib/vault/resolver";

async function buildConnection(): Promise<NativeConnection> {
  const address = temporalAddress();
  const tls = await resolveTemporalTls();
  return NativeConnection.connect({
    address,
    tls: tls
      ? {
          clientCertPair: {
            crt: tls.clientCertPair.crt,
            key: tls.clientCertPair.key,
          },
          serverRootCACertificate: tls.serverRootCACertificate,
          serverNameOverride: tls.serverNameOverride,
        }
      : undefined,
  });
}

async function main(): Promise<void> {
  // Pre-warm Vault so the first activity that needs a secret is hot.
  await warmupSecrets().catch(() => undefined);

  const connection = await buildConnection();
  logger.info(
    { address: temporalAddress(), namespace: env.TEMPORAL_NAMESPACE, taskQueue: TASK_QUEUE },
    "temporal worker connecting"
  );

  // Register the recurring Schedules once, idempotently, using a client over the
  // same connection.
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  await ensureSchedules(client).catch((e) =>
    logger.error({ err: e }, "ensureSchedules failed (continuing)")
  );

  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    // Temporal compiles the workflow code from source at runtime. The worker
    // itself is bundled to dist/worker.mjs, so resolve the workflow source from
    // the shipped tree (cwd = /app in the container) rather than the bundle dir.
    workflowsPath:
      process.env.TEMPORAL_WORKFLOWS_PATH ||
      path.resolve(process.cwd(), "src/worker/workflows/index.ts"),
    activities,
  });

  // Graceful shutdown: let in-flight activities finish on SIGTERM/SIGINT.
  const shutdown = (sig: string) => {
    logger.info({ sig }, "temporal worker shutting down");
    worker.shutdown();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info("temporal worker started; polling for tasks");
  await worker.run();
  await connection.close().catch(() => undefined);
  logger.info("temporal worker stopped");
}

main().catch((err) => {
  logger.error({ err }, "temporal worker crashed");
  process.exit(1);
});
