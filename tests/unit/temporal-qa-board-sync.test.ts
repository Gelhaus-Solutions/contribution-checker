import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { registerTestSearchAttributes } from "./helpers/search-attributes";
import { WF, SIG, QA_BOARD_POLL_INTERVAL_MS } from "@/lib/temporal/contracts";

/**
 * Time-skipping tests for the per-repo QA board mirror.
 *
 * Two properties matter here, and they pull in opposite directions. The entity
 * has to keep polling while a batch is open, because nothing local happens when
 * somebody moves a card in Trello and there is no signal to wait for. And it
 * has to stop once there is nothing to mirror, or every repo that ever linked a
 * board polls a provider forever.
 */
const TASK_QUEUE = "test-qa-board-sync";

type Pass = { applied: number; pushed: number; failed: number; idle: boolean };

const BUSY: Pass = { applied: 0, pushed: 0, failed: 0, idle: false };
const IDLE: Pass = { applied: 0, pushed: 0, failed: 0, idle: true };

async function run(
  workflowId: string,
  passes: Pass[],
  seed?: (
    handleId: string,
    client: TestWorkflowEnvironment["client"],
  ) => Promise<void>,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const syncs: Array<{ repoId: string }> = [];
  const reconciles: Array<{ repoId: string; reason: string }> = [];
  try {
    await registerTestSearchAttributes(env);
    await seed?.(workflowId, env.client);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: fileURLToPath(
        new URL("../../src/worker/workflows/index.ts", import.meta.url),
      ),
      activities: {
        async syncQaBoard(args: { repoId: string }) {
          syncs.push(args);
          // Last entry repeats, so a test only lists the passes it cares about.
          return passes[Math.min(syncs.length - 1, passes.length - 1)];
        },
        async signalStagingReconcile(args: { repoId: string; reason: string }) {
          reconciles.push(args);
        },
      },
    });

    await env.client.workflow.start(WF.qaBoardSync, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ repoId: "repo1" }],
    });

    await worker.runUntil(env.client.workflow.getHandle(workflowId).result());
    return { syncs, reconciles };
  } finally {
    await env.teardown();
  }
}

describe("qaBoardSync entity", () => {
  it("syncs once and completes when there is nothing in flight", async () => {
    const { syncs } = await run("qa-idle", [IDLE]);
    expect(syncs).toHaveLength(1);
  });

  it("keeps polling while a batch is open, then stops when it settles", async () => {
    // Three busy passes then idle: the entity must come back on its own timer,
    // because a card moved in Trello produces no local event to wake it.
    const { syncs } = await run("qa-poll", [BUSY, BUSY, BUSY, IDLE]);
    expect(syncs).toHaveLength(4);
  });

  it("hands a pulled verdict back to the staging entity", async () => {
    // Without this a verdict recorded in Notion never reaches the release PR
    // body or the QA check, and the integration is decorative.
    const { reconciles } = await run("qa-applied", [
      { applied: 2, pushed: 0, failed: 0, idle: false },
      IDLE,
    ]);
    expect(reconciles).toEqual([
      { repoId: "repo1", reason: "qa_board_pull" },
    ]);
  });

  it("does not disturb the staging entity when nothing was pulled", async () => {
    const { reconciles } = await run("qa-quiet", [BUSY, IDLE]);
    expect(reconciles).toEqual([]);
  });

  it("coalesces a burst of signals into one pass", async () => {
    const { syncs } = await run("qa-burst", [IDLE], async (id, client) => {
      const handle = client.workflow.getHandle(id);
      // Buffered before the worker polls, so the first workflow task sees all
      // three and the debounce has something to collapse.
      await handle.signal(SIG.qaBoardSync, { reason: "one" }).catch(() => {});
      await handle.signal(SIG.qaBoardSync, { reason: "two" }).catch(() => {});
      await handle.signal(SIG.qaBoardSync, { reason: "three" }).catch(() => {});
    });
    expect(syncs).toHaveLength(1);
  });

  it("polls on the documented interval", () => {
    // Guards the constant itself: dropping this to seconds would hammer the
    // provider API for every linked repo.
    expect(QA_BOARD_POLL_INTERVAL_MS).toBe(5 * 60_000);
  });
});
