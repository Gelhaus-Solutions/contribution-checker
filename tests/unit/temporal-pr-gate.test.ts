import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WF, SIG } from "@/lib/temporal/contracts";
import type {
  GithubEventEnvelope,
  ReGatePayload,
} from "@/lib/temporal/contracts";

/**
 * Time-skipping tests for the per-PR entity workflow (prGate). To stay
 * deterministic (the time-skipping server fast-forwards idle waits and the
 * post-completion clock is unreliable), each test buffers all signals on the
 * server BEFORE the worker starts polling, so the first workflow task drains a
 * known queue. We then assert the activity call pattern directly: a terminal
 * close (merge / human close) stops the drain and completes the gate, while a
 * non-terminal event (including the bot's own reopenable closedByApp close) lets
 * it keep processing.
 */
const TASK_QUEUE = "test-pr-gate";

/** convergePrEvent returns terminal only for this action, mirroring how the real
 * handler flags a merge / human close. */
const TERMINAL_ACTION = "closed-terminal";

function ev(action: string): GithubEventEnvelope {
  return { eventName: "pull_request", deliveryId: `d-${action}`, payload: { action } };
}

async function runGate(
  workflowId: string,
  seed: (handleId: string, client: TestWorkflowEnvironment["client"]) => Promise<void>,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const events: GithubEventEnvelope[] = [];
  const reGates: ReGatePayload[] = [];
  try {
    // Buffer every signal on the server first; the worker is created afterwards
    // so the workflow's first task sees the full queue at once.
    await seed(workflowId, env.client);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: {
        async convergePrEvent(e: GithubEventEnvelope) {
          events.push(e);
          return { terminal: (e.payload as { action: string }).action === TERMINAL_ACTION };
        },
        async convergePrReGate(args: ReGatePayload) {
          reGates.push(args);
        },
      },
    });

    await worker.runUntil(env.client.workflow.getHandle(workflowId).result());
  } finally {
    await env.teardown();
  }
  return { events, reGates };
}

describe("prGate", () => {
  it("drains every github event then idle-completes on a non-terminal stream", async () => {
    const { events } = await runGate("pr:1:1", async (id, client) => {
      await client.workflow.signalWithStart(WF.prGate, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        signal: SIG.githubEvent,
        signalArgs: [ev("opened")],
        args: [{ repoId: "1", prNumber: 1 }],
      });
      await client.workflow.getHandle(id).signal(SIG.githubEvent, ev("synchronize"));
    });
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual([
      "opened",
      "synchronize",
    ]);
  }, 60_000);

  it("stops draining and completes the gate on a terminal close", async () => {
    const { events } = await runGate("pr:2:2", async (id, client) => {
      await client.workflow.signalWithStart(WF.prGate, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        signal: SIG.githubEvent,
        signalArgs: [ev(TERMINAL_ACTION)],
        args: [{ repoId: "2", prNumber: 2 }],
      });
      // A later event after a terminal close must NOT be processed by this run:
      // the gate has already completed.
      await client.workflow.getHandle(id).signal(SIG.githubEvent, ev("synchronize"));
    });
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual([
      TERMINAL_ACTION,
    ]);
  }, 60_000);

  it("re-evaluates on a reGate request", async () => {
    const { events, reGates } = await runGate("pr:3:3", async (id, client) => {
      await client.workflow.signalWithStart(WF.prGate, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        signal: SIG.reGate,
        signalArgs: [{ reason: "config-change", nonce: "n1" }],
        args: [{ repoId: "3", prNumber: 3 }],
      });
    });
    expect(events).toHaveLength(0);
    expect(reGates).toHaveLength(1);
    expect(reGates[0].reason).toBe("config-change");
  }, 60_000);
});
