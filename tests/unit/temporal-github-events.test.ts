import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { WF } from "@/lib/temporal/contracts";

/**
 * processPush and processMergeGroup while GMint is not answering: the activity
 * refuses to report work done whose writes failed (GmintUnavailable), and the
 * workflow waits and runs it again. The time-skipping server fast-forwards the
 * waits.
 */
const TASK_QUEUE = "test-github-events";

const gmintDown = () =>
  ApplicationFailure.nonRetryable("GMint is not answering", "GmintUnavailable");

async function run(
  workflow: string,
  /** How many attempts fail as GMint not answering; Infinity for all. */
  failures: number,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  let calls = 0;
  let outcome: "completed" | "failed";
  try {
    const handle = await env.client.workflow.start(workflow, {
      workflowId: `${workflow}-1`,
      taskQueue: TASK_QUEUE,
      args: [{ payload: {} }],
    });
    const attempt = async () => {
      calls += 1;
      if (calls <= failures) throw gmintDown();
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: { processPushEvent: attempt, processMergeGroupEvent: attempt },
    });
    outcome = await worker.runUntil(
      handle.result().then(
        () => "completed" as const,
        () => "failed" as const,
      ),
    );
  } finally {
    await env.teardown();
  }
  return { calls, outcome };
}

describe("GitHub event workflows while GMint is not answering", () => {
  it("runs a push again until GMint answers", async () => {
    const { calls, outcome } = await run(WF.processPush, 6);
    expect(outcome).toBe("completed");
    expect(calls).toBe(7);
  });

  it("runs a merge group again until GMint answers", async () => {
    const { calls, outcome } = await run(WF.processMergeGroup, 2);
    expect(outcome).toBe("completed");
    expect(calls).toBe(3);
  });

  it("gives a merge group up once its queue entry is gone", async () => {
    // 1 + 2 + 5 minutes, then every 15: six hours is 27 waits, so 28 attempts.
    const { calls, outcome } = await run(WF.processMergeGroup, Infinity);
    expect(outcome).toBe("failed");
    expect(calls).toBe(28);
  });
});
