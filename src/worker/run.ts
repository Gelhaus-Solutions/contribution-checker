import path from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { WorkerDeploymentOptions } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import * as activities from "./activities";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/** Build Worker Deployment options from env, or null when versioning is off. */
function buildDeploymentOptions(): WorkerDeploymentOptions | null {
  if (!env.TEMPORAL_VERSIONING_ENABLED) return null;
  if (!env.TEMPORAL_BUILD_ID) {
    throw new Error(
      "TEMPORAL_VERSIONING_ENABLED=true requires TEMPORAL_BUILD_ID (set it to " +
        "the image tag / git sha, unique per worker code version)."
    );
  }
  logger.info(
    {
      deploymentName: env.TEMPORAL_DEPLOYMENT_NAME,
      buildId: env.TEMPORAL_BUILD_ID,
      defaultVersioningBehavior: env.TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR,
    },
    "worker deployments enabled"
  );
  return {
    useWorkerVersioning: true,
    version: {
      deploymentName: env.TEMPORAL_DEPLOYMENT_NAME,
      buildId: env.TEMPORAL_BUILD_ID,
    },
    defaultVersioningBehavior: env.TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR,
  };
}
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

  // Worker Deployments / Versioning (opt-in). When enabled the worker joins a
  // Deployment under a Build ID, enabling safe rolling deploys and the
  // worker/version heartbeats the server tracks. See docs.temporal.io/worker-deployments.
  const workerDeploymentOptions = buildDeploymentOptions();

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
    ...(workerDeploymentOptions ? { workerDeploymentOptions } : {}),
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
