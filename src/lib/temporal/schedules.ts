import "server-only";
import type { Client } from "@temporalio/client";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { TASK_QUEUE, scheduleIds } from "./task-queue";
import { WF } from "./contracts";
import { logger } from "@/lib/logger";

type ScheduleSpec = {
  id: string;
  workflowType: string;
  /** Cron expression (UTC). */
  cron: string;
};

/**
 * The recurring schedules. Reconcile + CLA sweeping moved onto per-project
 * timers owned by the projectGate entities; the only sweep-adjacent schedule
 * left is the ensureProjectGates keepalive that bootstraps/nudges those
 * entities. Each schedule starts a fresh workflow run on fire, so the runs
 * stay short and history-bounded.
 */
const SCHEDULES: ScheduleSpec[] = [
  // Project-entity keepalive: enumerate active projects and signalWithStart
  // each projectGate (bootstraps new projects, resurrects retired entities).
  {
    id: scheduleIds.ensureProjectGates,
    workflowType: WF.ensureProjectGates,
    cron: "*/10 * * * *",
  },
  // Prune stale inbound-delivery idempotency rows, daily at 03:00 UTC.
  {
    id: scheduleIds.pruneProcessedDeliveries,
    workflowType: WF.pruneProcessedDeliveries,
    cron: "0 3 * * *",
  },
];

/** Schedules retired by the projectGate migration, actively deleted on startup
 * so the old crons stop firing (their workflow types remain in the bundle for
 * one deploy cycle so in-flight runs can finish). */
const RETIRED_SCHEDULE_IDS = [scheduleIds.reconcileSweep, scheduleIds.claSweep];

/**
 * Idempotently ensure every schedule exists and every retired schedule is
 * gone. Called once at worker startup. Creating an already-existing schedule
 * throws ScheduleAlreadyRunning, which we treat as success (the deploy is
 * just restarting); deleting a missing schedule is likewise a no-op.
 */
export async function ensureSchedules(client: Client): Promise<void> {
  for (const spec of SCHEDULES) {
    try {
      await client.schedule.create({
        scheduleId: spec.id,
        spec: { cronExpressions: [spec.cron] },
        action: {
          type: "startWorkflow",
          workflowType: spec.workflowType,
          taskQueue: TASK_QUEUE,
        },
        policies: {
          // A long-running sweep must never pile up on top of itself.
          overlap: ScheduleOverlapPolicy.SKIP,
        },
      });
      logger.info({ scheduleId: spec.id, cron: spec.cron }, "temporal schedule created");
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      if (name === "ScheduleAlreadyRunning") {
        logger.debug({ scheduleId: spec.id }, "temporal schedule already exists");
        continue;
      }
      throw e;
    }
  }

  for (const scheduleId of RETIRED_SCHEDULE_IDS) {
    try {
      await client.schedule.getHandle(scheduleId).delete();
      logger.info({ scheduleId }, "retired temporal schedule deleted");
    } catch {
      // Already gone (or never created on this cluster): nothing to retire.
    }
  }
}
