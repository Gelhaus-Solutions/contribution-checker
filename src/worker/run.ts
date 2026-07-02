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
import {
  ensureSearchAttributes,
  indexedValueTypeName,
} from "@/lib/temporal/search-attribute-registration";
import { warmupSecrets } from "@/lib/vault/resolver";

/**
 * Self-register the custom Search Attributes on the namespace, the same way
 * the container entrypoint self-applies DB migrations (`prisma migrate
 * deploy`): there is no separate operator step in the deploy path, and the
 * docker-compose dev server is in-memory (it forgets registrations on every
 * restart). Without them, every entity signalWithStart that carries typed
 * attributes is rejected with INVALID_ARGUMENT and the scheduled
 * ensureProjectGates workflow fails permanently. Idempotent and race-safe
 * across replicas; never fatal: on failure the worker still boots and the
 * client side degrades by dropping the attributes (see start.ts).
 */
async function registerSearchAttributes(
  connection: NativeConnection
): Promise<void> {
  const namespace = env.TEMPORAL_NAMESPACE;
  try {
    const res = await ensureSearchAttributes(
      connection.operatorService,
      namespace
    );
    if (res.added.length > 0) {
      logger.info(
        { namespace, added: res.added },
        "registered temporal search attributes"
      );
    }
    for (const m of res.mismatched) {
      logger.error(
        {
          namespace,
          name: m.name,
          registered: indexedValueTypeName(m.registered),
          wanted: indexedValueTypeName(m.wanted),
        },
        "temporal search attribute is registered with a different type; " +
          "executions that carry or upsert it will be rejected until it is " +
          "deleted and recreated on the namespace (or renamed in code)"
      );
    }
    for (const f of res.failed) {
      logger.error(
        { err: f.error, namespace, name: f.name },
        "registering temporal search attribute failed (per-type visibility " +
          "caps or missing permission); executions carrying it degrade to " +
          "attribute-less starts"
      );
    }
  } catch (e) {
    logger.error(
      { err: e, namespace },
      "could not inspect the namespace's search attributes; register them " +
        "out of band (Temporal Cloud blocks the Operator API: use tcld or " +
        "the UI; self-hosted: pnpm temporal:register-sa)"
    );
  }
}

/**
 * Set this worker's Build ID as the deployment's Current version, retrying
 * until the version has registered (the worker must poll at least once before
 * the server knows it exists). Idempotent; safe to call on every startup.
 */
async function promoteCurrentVersion(
  client: Client,
  buildId: string
): Promise<void> {
  const deploymentName = env.TEMPORAL_DEPLOYMENT_NAME;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await client.workflowService.setWorkerDeploymentCurrentVersion({
        namespace: env.TEMPORAL_NAMESPACE,
        deploymentName,
        buildId,
        identity: `${deploymentName}-worker`,
      });
      logger.info({ deploymentName, buildId }, "set current deployment version");
      return;
    } catch (e) {
      // The version isn't registered yet right after startup; back off and retry.
      if (attempt === 20) {
        logger.error(
          { err: e, deploymentName, buildId },
          "failed to set current deployment version after retries"
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

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

  // Namespace-level prerequisites, both idempotent: the custom Search
  // Attributes FIRST (the scheduled ensureProjectGates run signalWithStarts
  // the project entities with typed attributes, so the first tick must find
  // them registered), then the recurring Schedules, using a client over the
  // same connection.
  await registerSearchAttributes(connection);
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

  // Auto-promote this Build ID to Current once it has registered (opt-in). Runs
  // concurrently with the poller because the version only exists on the server
  // after the worker has polled at least once.
  if (
    env.TEMPORAL_VERSIONING_ENABLED &&
    env.TEMPORAL_SET_CURRENT_ON_START &&
    env.TEMPORAL_BUILD_ID
  ) {
    void promoteCurrentVersion(client, env.TEMPORAL_BUILD_ID);
  }

  await worker.run();
  await connection.close().catch(() => undefined);
  logger.info("temporal worker stopped");
}

main().catch((err) => {
  logger.error({ err }, "temporal worker crashed");
  process.exit(1);
});
