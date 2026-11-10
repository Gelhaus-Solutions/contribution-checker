import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { registerTestSearchAttributes } from "./helpers/search-attributes";
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
  /** How many converges fail as GMint not answering before one goes through. */
  gmintDown = 0,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const events: GithubEventEnvelope[] = [];
  const reGates: ReGatePayload[] = [];
  try {
    // The gate upserts custom Search Attributes; register them or the first
    // workflow task fails ("search attribute RepoId is not defined") forever.
    await registerTestSearchAttributes(env);
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
          if (gmintDown > 0) {
            gmintDown -= 1;
            throw ApplicationFailure.nonRetryable("GMint is not answering", "GmintUnavailable");
          }
          return { terminal: (e.payload as { action: string }).action === TERMINAL_ACTION };
        },
        async convergePrReGate(args: ReGatePayload) {
          reGates.push(args);
          if (gmintDown > 0) {
            gmintDown -= 1;
            throw ApplicationFailure.nonRetryable("GMint is not answering", "GmintUnavailable");
          }
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

  // A converge whose GitHub writes failed because GMint was down is not done:
  // the event stays at the head of the queue and is converged again after a
  // wait, and the event behind it waits its turn.
  it("waits while GMint is not answering and converges the same event again", async () => {
    const { events } = await runGate(
      "pr:4:4",
      async (id, client) => {
        await client.workflow.signalWithStart(WF.prGate, {
          workflowId: id,
          taskQueue: TASK_QUEUE,
          signal: SIG.githubEvent,
          signalArgs: [ev("opened")],
          args: [{ repoId: "4", prNumber: 4 }],
        });
        await client.workflow.getHandle(id).signal(SIG.githubEvent, ev("synchronize"));
      },
      3,
    );
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual([
      "opened",
      "opened",
      "opened",
      "opened",
      "synchronize",
    ]);
  }, 60_000);

  it("waits the same way on a re-gate", async () => {
    const { reGates } = await runGate(
      "pr:5:5",
      async (id, client) => {
        await client.workflow.signalWithStart(WF.prGate, {
          workflowId: id,
          taskQueue: TASK_QUEUE,
          signal: SIG.reGate,
          signalArgs: [{ reason: "admin_reevaluate", nonce: "n5" }],
          args: [{ repoId: "5", prNumber: 5 }],
        });
      },
      2,
    );
    expect(reGates).toHaveLength(3);
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
