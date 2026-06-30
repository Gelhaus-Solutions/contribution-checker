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
 * The recurring sweeps, as Temporal Schedules. These replace the external
 * GitHub-Actions cron (reconcile), the admin-triggered CLA sweep, and the
 * inline processed-delivery prune. Each schedule starts a fresh workflow run on
 * fire, so the runs stay short and history-bounded.
 */
const SCHEDULES: ScheduleSpec[] = [
  // App-mode reconcile safety net, every 10 minutes (matches the old CI cron).
  { id: scheduleIds.reconcileSweep, workflowType: WF.reconcileSweep, cron: "*/10 * * * *" },
  // CLA unsigned-applicant sweep, hourly.
  { id: scheduleIds.claSweep, workflowType: WF.claSweep, cron: "0 * * * *" },
  // Prune stale inbound-delivery idempotency rows, daily at 03:00 UTC.
  {
    id: scheduleIds.pruneProcessedDeliveries,
    workflowType: WF.pruneProcessedDeliveries,
    cron: "0 3 * * *",
  },
];

/**
 * Idempotently ensure every schedule exists. Called once at worker startup.
 * Creating an already-existing schedule throws ScheduleAlreadyRunning, which we
 * treat as success (the deploy is just restarting).
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
}
