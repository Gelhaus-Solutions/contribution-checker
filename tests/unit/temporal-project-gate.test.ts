import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { registerTestSearchAttributes } from "./helpers/search-attributes";
import { WF, SIG } from "@/lib/temporal/contracts";

/**
 * Time-skipping tests for the per-project entity workflow (projectGate). It
 * owns the per-project reconcile/CLA sweep timers (replacing the global crons)
 * and the batched re-gate fan-out. The time-skipping server fast-forwards the
 * sweep deadlines, and the entity retires once reconcileProject reports the
 * project inactive, which is how each test terminates.
 */
const TASK_QUEUE = "test-project-gate";

type ReGateBatch = {
  targets: { ghRepoId: number; prNumber: number }[];
  reason: string;
  nonce: string;
};

type Mocks = {
  reconciles: number;
  /** Per-reconcile results, consumed in order (last one repeats). */
  reconcileResults: { active: boolean; claEnabled: boolean }[];
  claSweeps: number;
  listCalls: { cursor: string | null }[];
  batches: ReGateBatch[];
};

async function runGate(
  workflowId: string,
  mocks: Mocks,
  seed: (id: string, client: TestWorkflowEnvironment["client"]) => Promise<void>,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    // The gate upserts custom Search Attributes; register them or the first
    // workflow task fails ("search attribute ... is not defined") forever.
    await registerTestSearchAttributes(env);
    await seed(workflowId, env.client);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: {
        async reconcileProject() {
          const res =
            mocks.reconcileResults[
              Math.min(mocks.reconciles, mocks.reconcileResults.length - 1)
            ];
          mocks.reconciles += 1;
          return { reopened: 0, evaluated: 0, ...res };
        },
        async claSweepProject() {
          mocks.claSweeps += 1;
          return { notified: 0, skipped: 0, total: 0 };
        },
        async listReGatePrTargets(args: { cursor: string | null }) {
          mocks.listCalls.push({ cursor: args.cursor });
          // Two pages: a full-looking page with a cursor, then the tail.
          if (args.cursor === null) {
            return {
              targets: [
                { ghRepoId: 9, prNumber: 1 },
                { ghRepoId: 9, prNumber: 2 },
              ],
              nextCursor: "page2",
            };
          }
          return { targets: [{ ghRepoId: 9, prNumber: 3 }], nextCursor: null };
        },
        async signalReGateBatch(args: ReGateBatch) {
          mocks.batches.push(args);
          return { signaled: args.targets.length };
        },
      },
    });

    await worker.runUntil(env.client.workflow.getHandle(workflowId).result());
  } finally {
    await env.teardown();
  }
}

describe("projectGate", () => {
  it("fans out a reGateAll in nonce-sharing batches, then retires when inactive", async () => {
    const mocks: Mocks = {
      reconciles: 0,
      // First (time-skipped) reconcile reports the project gone → retire.
      reconcileResults: [{ active: false, claEnabled: false }],
      claSweeps: 0,
      listCalls: [],
      batches: [],
    };
    await runGate("project:proj1", mocks, async (id, client) => {
      await client.workflow.signalWithStart(WF.projectGate, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        signal: SIG.reGateAll,
        signalArgs: [{ reason: "config_changed", nonce: "n-1" }],
        args: [{ projectId: "proj1" }],
      });
    });

    // Both pages fanned out, sharing the one nonce (prGate coalescing key).
    expect(mocks.listCalls).toEqual([{ cursor: null }, { cursor: "page2" }]);
    expect(mocks.batches.map((b) => b.targets.length)).toEqual([2, 1]);
    expect(new Set(mocks.batches.map((b) => b.nonce))).toEqual(new Set(["n-1"]));
    expect(mocks.batches[0]?.reason).toBe("config_changed");
    // The sweep timer fired (time-skipped) and the inactive report retired it.
    expect(mocks.reconciles).toBe(1);
  });

  it("re-arms the reconcile timer while active and retires once inactive", async () => {
    const mocks: Mocks = {
      reconciles: 0,
      reconcileResults: [
        { active: true, claEnabled: false },
        { active: false, claEnabled: false },
      ],
      claSweeps: 0,
      listCalls: [],
      batches: [],
    };
    await runGate("project:proj2", mocks, async (id, client) => {
      await client.workflow.signalWithStart(WF.projectGate, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        signal: SIG.sweepTick,
        signalArgs: [{}],
        args: [{ projectId: "proj2" }],
      });
    });

    // First fire re-armed (+10 min, time-skipped); second fire retired it.
    expect(mocks.reconciles).toBe(2);
    expect(mocks.claSweeps).toBe(0);
  });
});
