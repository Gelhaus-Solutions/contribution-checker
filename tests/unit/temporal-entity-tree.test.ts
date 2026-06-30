import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WF, SIG } from "@/lib/temporal/contracts";
import type { GithubEventEnvelope } from "@/lib/temporal/contracts";

/**
 * Time-skipping test for the contributor → pr parent/child link. A PR event sent
 * to the contributorGate must start a prGate CHILD (startChild, so the
 * Relationships tab shows the tree), the child must run the converge, and on a
 * terminal close the child reports completion so the parent drops it and
 * completes too.
 */
const TASK_QUEUE = "test-entity-tree";
const TERMINAL_ACTION = "closed-terminal";

function ev(action: string): GithubEventEnvelope {
  return { eventName: "pull_request", deliveryId: `d-${action}`, payload: { action } };
}

describe("contributor → pr tree", () => {
  it("starts a prGate child for a PR event and completes when the child does", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const converged: GithubEventEnvelope[] = [];
    try {
      await env.client.workflow.signalWithStart(WF.contributorGate, {
        workflowId: "contrib:proj1:7",
        taskQueue: TASK_QUEUE,
        signal: SIG.prEvent,
        signalArgs: [{ ghRepoId: "9", prNumber: 7, envelope: ev(TERMINAL_ACTION) }],
        args: [{ projectId: "proj1", authorGhId: 7 }],
      });

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: fileURLToPath(
          new URL("../../src/worker/workflows/index.ts", import.meta.url),
        ),
        activities: {
          async convergePrEvent(e: GithubEventEnvelope) {
            converged.push(e);
            return {
              terminal: (e.payload as { action: string }).action === TERMINAL_ACTION,
            };
          },
          async convergePrReGate() {},
          // contributorGate fan-out activities (not exercised by a pure PR event):
          async runApplicationPostDecision() {
            return { affectedPrs: 0 };
          },
          async readApplicationCooldown() {
            return null;
          },
          async elapseApplicationCooldown() {},
          async claSweepProject() {},
          async applyClaCoverageChange() {},
        },
      });

      await worker.runUntil(
        env.client.workflow.getHandle("contrib:proj1:7").result(),
      );

      // The child ran the converge for our event...
      expect(converged.map((e) => (e.payload as { action: string }).action)).toEqual([
        TERMINAL_ACTION,
      ]);

      // ...and it was a real CHILD of the contributorGate (parent link present).
      const desc = await env.client.workflow.getHandle("pr:9:7").describe();
      expect(desc.parentExecution?.workflowId).toBe("contrib:proj1:7");
    } finally {
      await env.teardown();
    }
  }, 60_000);
});
