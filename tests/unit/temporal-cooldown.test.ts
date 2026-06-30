import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { applicationCooldownTimer } from "@/worker/workflows/applications";

/**
 * Time-skipping test for the durable cooldown timer. The workflow sleeps until
 * the cooldown date, then calls the elapse activity exactly once. The test
 * server fast-forwards the timer, so a 30-day cooldown resolves instantly and
 * deterministically.
 */
describe("applicationCooldownTimer", () => {
  it("fires the elapse activity after the cooldown sleep", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    try {
      const calls: string[] = [];
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: "test-cooldown",
        workflowsPath: fileURLToPath(
          new URL("../../src/worker/workflows/index.ts", import.meta.url)
        ),
        activities: {
          // Only the activity this workflow invokes needs a mock.
          async elapseApplicationCooldown(applicationId: string) {
            calls.push(applicationId);
          },
        },
      });

      await worker.runUntil(async () => {
        // A far-future cooldown; the time-skipping server fast-forwards the
        // workflow's durable sleep, so the test completes in milliseconds.
        const cooldownUntilIso = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString();
        await env.client.workflow.execute(applicationCooldownTimer, {
          workflowId: "test-cooldown-1",
          taskQueue: "test-cooldown",
          args: [{ applicationId: "app_123", cooldownUntilIso }],
        });
      });

      expect(calls).toEqual(["app_123"]);
    } finally {
      await env.teardown();
    }
  }, 60_000);
});
