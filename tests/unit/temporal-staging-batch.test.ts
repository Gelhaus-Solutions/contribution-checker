import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { registerTestSearchAttributes } from "./helpers/search-attributes";
import {
  WF,
  SIG,
  STAGING_SYNC_WINDOW_MS,
} from "@/lib/temporal/contracts";

/**
 * Time-skipping tests for the per-repo staging batch entity. Same determinism
 * discipline as the prGate tests: every signal is buffered on the server BEFORE
 * the worker starts polling, so the first workflow task sees a known state.
 *
 * The property under test is coalescing. Reconciling is a full re-derivation
 * from live GitHub, so a burst of signals must collapse into one activity call,
 * while a signal that genuinely arrives after a reconcile started must earn
 * another one.
 */
const TASK_QUEUE = "test-staging-batch";

/** A pass that neither synced nor wants to. */
const NOTHING_DONE = {
  synced: false,
  syncDeferred: false,
  syncEligibleAtMs: null,
};

async function runBatch(
  workflowId: string,
  seed: (
    handleId: string,
    client: TestWorkflowEnvironment["client"],
  ) => Promise<void>,
  onReconcile?: (calls: number) => Promise<void>,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const reconciles: Array<{ repoId: string }> = [];
  try {
    await registerTestSearchAttributes(env);
    await seed(workflowId, env.client);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: {
        async convergeStagingBatch(args: { repoId: string }) {
          reconciles.push(args);
          await onReconcile?.(reconciles.length);
          return NOTHING_DONE;
        },
      },
    });

    await worker.runUntil(env.client.workflow.getHandle(workflowId).result());
  } finally {
    await env.teardown();
  }
  return { reconciles };
}

function start(client: TestWorkflowEnvironment["client"], id: string, repoId: string) {
  return client.workflow.signalWithStart(WF.stagingBatch, {
    workflowId: id,
    taskQueue: TASK_QUEUE,
    signal: SIG.stagingReconcile,
    signalArgs: [{ reason: "pr_retargeted" }],
    args: [{ repoId }],
  });
}

describe("stagingBatch", () => {
  it("collapses a burst of signals into a single reconcile", async () => {
    const { reconciles } = await runBatch(
      "staging:repo1",
      async (id, client) => {
        await start(client, id, "repo1");
        const handle = client.workflow.getHandle(id);
        await handle.signal(SIG.stagingReconcile, { reason: "pr_opened" });
        await handle.signal(SIG.stagingReconcile, { reason: "push_to_staging" });
        await handle.signal(SIG.stagingReconcile, { reason: "pr_title_edited" });
      },
    );
    // Four signals, one pass over the GitHub API.
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0].repoId).toBe("repo1");
  });

  it("earns a second reconcile for a signal that arrives mid-reconcile", async () => {
    // Signalling from inside the activity is what proves the read-then-clear
    // ordering: `dirty` is cleared BEFORE the activity runs, so a request
    // landing during it is not swallowed.
    let env: TestWorkflowEnvironment | null = null;
    const reconciles: Array<{ repoId: string }> = [];
    env = await TestWorkflowEnvironment.createTimeSkipping();
    try {
      await registerTestSearchAttributes(env);
      const id = "staging:repo2";
      await start(env.client, id, "repo2");
      const handle = env.client.workflow.getHandle(id);

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: fileURLToPath(
          new URL("../../src/worker/workflows/index.ts", import.meta.url),
        ),
        activities: {
          async convergeStagingBatch(args: { repoId: string }) {
            reconciles.push(args);
            if (reconciles.length === 1) {
              await handle.signal(SIG.stagingReconcile, {
                reason: "pr_merged_to_staging",
              });
            }
            return NOTHING_DONE;
          },
        },
      });
      await worker.runUntil(handle.result());
    } finally {
      await env.teardown();
    }
    expect(reconciles).toHaveLength(2);
  });

  it("idle-completes without reconciling when no signal ever arrives", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const reconciles: Array<{ repoId: string }> = [];
    try {
      await registerTestSearchAttributes(env);
      const id = "staging:repo3";
      await env.client.workflow.start(WF.stagingBatch, {
        workflowId: id,
        taskQueue: TASK_QUEUE,
        args: [{ repoId: "repo3" }],
      });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: fileURLToPath(
          new URL("../../src/worker/workflows/index.ts", import.meta.url),
        ),
        activities: {
          async convergeStagingBatch(args: { repoId: string }) {
            reconciles.push(args);
            return NOTHING_DONE;
          },
        },
      });
      await worker.runUntil(
        env.client.workflow.getHandle(id).result(),
      );
    } finally {
      await env.teardown();
    }
    expect(reconciles).toHaveLength(0);
  });

  it("holds the next sync back until the batching window closes", async () => {
    // A burst of pushes to the default branch must cost one merge commit on
    // staging, not one per push. The activity owns the window (it reads the
    // last sync off the repo row) and reports when it lifts; the entity's job
    // is to still be there at that moment instead of idling out. The
    // time-skipping server fast-forwards the wait, so this is not a slow test.
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: number[] = [];
    try {
      await registerTestSearchAttributes(env);
      const id = "staging:repo4";
      await start(env.client, id, "repo4");
      const handle = env.client.workflow.getHandle(id);

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: fileURLToPath(
          new URL("../../src/worker/workflows/index.ts", import.meta.url),
        ),
        activities: {
          async convergeStagingBatch(_args: { repoId: string }) {
            calls.push(calls.length + 1);
            if (calls.length === 1) {
              // First pass syncs, which opens the window; then another push
              // to the default branch lands immediately.
              await handle.signal(SIG.stagingReconcile, {
                reason: "push_to_default",
              });
              return { synced: true, syncDeferred: false, syncEligibleAtMs: null };
            }
            // Second pass is inside the window and reports the deferral with
            // the moment it lifts. The entity must sleep past it and come back
            // rather than completing on the idle timeout.
            if (calls.length === 2) {
              return {
                synced: false,
                syncDeferred: true,
                syncEligibleAtMs: Date.now() + STAGING_SYNC_WINDOW_MS,
              };
            }
            return { synced: true, syncDeferred: false, syncEligibleAtMs: null };
          },
        },
      });
      await worker.runUntil(handle.result());
    } finally {
      await env.teardown();
    }
    // The held-back sync ran: three passes, not two.
    expect(calls).toEqual([1, 2, 3]);
  });
});
