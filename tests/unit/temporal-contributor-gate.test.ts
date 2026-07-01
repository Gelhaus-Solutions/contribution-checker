import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { registerTestSearchAttributes } from "./helpers/search-attributes";
import { WF, SIG } from "@/lib/temporal/contracts";
import type { DecisionChangedPayload } from "@/lib/temporal/contracts";

/**
 * Time-skipping tests for the per-contributor entity workflow (contributorGate).
 * It consolidates the application-decision fan-out and the durable cooldown
 * timer: a decision runs the fan-out, re-reads the application's cooldown, and
 * arms a durable timer that the time-skipping server fast-forwards so a
 * months-long cooldown resolves instantly.
 */
const TASK_QUEUE = "test-contributor-gate";

type Mocks = {
  postDecision: DecisionChangedPayload[];
  elapsed: string[];
  cooldownIso: string | null;
};

async function runGate(workflowId: string, cooldownIso: string | null, payload: DecisionChangedPayload) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const mocks: Mocks = { postDecision: [], elapsed: [], cooldownIso };
  try {
    // The gate upserts custom Search Attributes; register them or the first
    // workflow task fails ("search attribute ... is not defined") forever.
    await registerTestSearchAttributes(env);
    await env.client.workflow.signalWithStart(WF.contributorGate, {
      workflowId,
      taskQueue: TASK_QUEUE,
      signal: SIG.decisionChanged,
      signalArgs: [payload],
      args: [{ projectId: "proj1", authorGhId: 42 }],
    });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: {
        async runApplicationPostDecision(input: DecisionChangedPayload) {
          mocks.postDecision.push(input);
          return { affectedPrs: 0 };
        },
        async readApplicationCooldown() {
          return mocks.cooldownIso;
        },
        async elapseApplicationCooldown(applicationId: string) {
          mocks.elapsed.push(applicationId);
        },
        async claSweepProject() {},
        async applyClaCoverageChange() {},
      },
    });

    await worker.runUntil(env.client.workflow.getHandle(workflowId).result());
  } finally {
    await env.teardown();
  }
  return mocks;
}

describe("contributorGate", () => {
  it("runs the decision fan-out and fires the armed cooldown timer", async () => {
    const cooldown = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const mocks = await runGate("contrib:proj1:42", cooldown, {
      kind: "denied",
      applicationId: "app_1",
      args: {},
    });
    expect(mocks.postDecision).toHaveLength(1);
    expect(mocks.postDecision[0].kind).toBe("denied");
    // The cooldown was armed and the time-skipping server fast-forwarded it.
    expect(mocks.elapsed).toEqual(["app_1"]);
  }, 60_000);

  it("completes without arming a timer when there is no cooldown", async () => {
    const mocks = await runGate("contrib:proj1:43", null, {
      kind: "approved",
      applicationId: "app_2",
      args: {},
    });
    expect(mocks.postDecision).toHaveLength(1);
    expect(mocks.elapsed).toEqual([]); // no cooldown → timer never fires
  }, 60_000);
});
