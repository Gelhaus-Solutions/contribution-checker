import { beforeEach, describe, expect, it, vi } from "vitest";

const batchFindFirst = vi.fn();
const batchCreate = vi.fn();
const batchUpdate = vi.fn();
const itemFindMany = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const itemUpdateMany = vi.fn();
const repoFindUnique = vi.fn();
const auditCreate = vi.fn();
const notifyProjectReviewers = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    stagingBatch: {
      findFirst: (...a: unknown[]) => batchFindFirst(...a),
      create: (...a: unknown[]) => batchCreate(...a),
      update: (...a: unknown[]) => batchUpdate(...a),
    },
    stagingBatchItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      create: (...a: unknown[]) => itemCreate(...a),
      update: (...a: unknown[]) => itemUpdate(...a),
      updateMany: (...a: unknown[]) => itemUpdateMany(...a),
    },
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}));

vi.mock("@/lib/notifications/inbox", () => ({
  notifyProjectReviewers: (...a: unknown[]) => notifyProjectReviewers(...a),
}));

import { markBatchShipped, syncBatchRecord } from "@/lib/qa/batch-record";
import type { PrSummary } from "@/lib/github/pr-actions";

const BATCH = { id: "batch1", repoId: "repo1", status: "OPEN", prNumber: 500 };

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 101,
    title: "Add retries to the sender",
    state: "closed",
    merged: true,
    mergedAt: "2026-08-01T10:00:00Z",
    mergeCommitSha: "aaa111",
    body: "Adds retries.\n\n## QA\nSend a webhook and kill the receiver.",
    baseRef: "staging",
    headRef: "feat/retry",
    authorLogin: "alice",
    labels: ["enhancement"],
    ...overrides,
  };
}

/** An existing row as the database would hand it back. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "item1",
    batchId: "batch1",
    key: "pr:101",
    kind: "PR",
    prNumber: 101,
    mergeCommitSha: "aaa111",
    qaStatus: "QA_PENDING",
    droppedAt: null,
    ...overrides,
  };
}

const ARGS = {
  repoId: "repo1",
  projectId: "proj1",
  standingChecks: [] as string[],
  aggregatePrNumber: 500,
};

beforeEach(() => {
  for (const m of [
    batchFindFirst,
    batchCreate,
    batchUpdate,
    itemFindMany,
    itemCreate,
    itemUpdate,
    itemUpdateMany,
    repoFindUnique,
    auditCreate,
    notifyProjectReviewers,
  ]) {
    m.mockReset();
  }
  batchFindFirst.mockResolvedValue(BATCH);
  batchCreate.mockResolvedValue(BATCH);
  batchUpdate.mockResolvedValue(BATCH);
  itemFindMany.mockResolvedValue([]);
  itemCreate.mockResolvedValue({});
  itemUpdate.mockResolvedValue({});
  itemUpdateMany.mockResolvedValue({ count: 0 });
  auditCreate.mockResolvedValue({});
  notifyProjectReviewers.mockResolvedValue(undefined);
  repoFindUnique.mockResolvedValue({
    fullName: "acme/app",
    project: { slug: "acme" },
    projectId: "proj1",
  });
});

describe("syncBatchRecord", () => {
  it("creates an item per merged PR, carrying the extracted QA steps", async () => {
    const result = await syncBatchRecord({ ...ARGS, prs: [pr()] });

    expect(result.added).toBe(1);
    const data = itemCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      batchId: "batch1",
      key: "pr:101",
      kind: "PR",
      prNumber: 101,
      title: "Add retries to the sender",
      authorLogin: "alice",
      mergeCommitSha: "aaa111",
      qaSteps: "Send a webhook and kill the receiver.",
      summary: "Adds retries.",
    });
    expect(JSON.parse(data.labels)).toEqual(["enhancement"]);
  });

  it("opens a batch when the repo has none", async () => {
    batchFindFirst.mockResolvedValue(null);
    await syncBatchRecord({ ...ARGS, prs: [pr()] });
    expect(batchCreate).toHaveBeenCalledWith({
      data: { repoId: "repo1", status: "OPEN", prNumber: 500 },
    });
  });

  it("preserves a recorded verdict across a reconcile", async () => {
    itemFindMany.mockResolvedValue([
      row({ qaStatus: "QA_PASSED", qaById: "user1" }),
    ]);

    const result = await syncBatchRecord({ ...ARGS, prs: [pr()] });

    expect(result.reset).toBe(0);
    const data = itemUpdate.mock.calls[0][0].data;
    // The update re-derives the GitHub-owned fields and must not touch a single
    // verdict field: that is what stops a reconcile erasing a morning of
    // testing. `qaSteps` is not a verdict, it is read back off the PR body.
    for (const field of [
      "qaStatus",
      "qaById",
      "qaByExternal",
      "qaAt",
      "qaNotes",
    ]) {
      expect(data).not.toHaveProperty(field);
    }
    expect(data.title).toBe("Add retries to the sender");
    expect(data.qaSteps).toBe("Send a webhook and kill the receiver.");
  });

  it("resets the verdict when the PR was re-merged", async () => {
    itemFindMany.mockResolvedValue([
      row({ qaStatus: "QA_PASSED", qaById: "user1", mergeCommitSha: "old000" }),
    ]);

    const result = await syncBatchRecord({ ...ARGS, prs: [pr()] });

    expect(result.reset).toBe(1);
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({
      qaStatus: "QA_PENDING",
      qaById: null,
      qaAt: null,
      qaNotes: null,
    });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "qa.item_reset" }),
      }),
    );
  });

  it("does not reset an item that had no verdict to lose", async () => {
    itemFindMany.mockResolvedValue([
      row({ qaStatus: "QA_PENDING", mergeCommitSha: "old000" }),
    ]);

    const result = await syncBatchRecord({ ...ARGS, prs: [pr()] });

    expect(result.reset).toBe(0);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("marks an item dropped instead of deleting it", async () => {
    itemFindMany.mockResolvedValue([row({ qaStatus: "QA_PASSED" })]);

    await syncBatchRecord({ ...ARGS, prs: [] });

    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["item1"] } },
      data: { droppedAt: expect.any(Date) },
    });
  });

  it("clears droppedAt when an item comes back", async () => {
    itemFindMany.mockResolvedValue([
      row({ qaStatus: "QA_PASSED", droppedAt: new Date("2026-08-01") }),
    ]);

    await syncBatchRecord({ ...ARGS, prs: [pr()] });

    expect(itemUpdate.mock.calls[0][0].data.droppedAt).toBeNull();
    // Coming back must not cost it its verdict either.
    expect(itemUpdate.mock.calls[0][0].data.qaStatus).toBeUndefined();
  });

  it("reports a regression when work lands in a batch that was green", async () => {
    itemFindMany.mockResolvedValue([row({ qaStatus: "QA_PASSED" })]);

    const result = await syncBatchRecord({
      ...ARGS,
      prs: [pr(), pr({ number: 102, mergeCommitSha: "bbb222" })],
    });

    expect(result.regressed).toBe(true);
    expect(notifyProjectReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "qa.items_added" }),
    );
  });

  it("does not report a regression when the batch was already incomplete", async () => {
    itemFindMany.mockResolvedValue([row({ qaStatus: "QA_PENDING" })]);

    const result = await syncBatchRecord({
      ...ARGS,
      prs: [pr(), pr({ number: 102, mergeCommitSha: "bbb222" })],
    });

    expect(result.regressed).toBe(false);
  });

  it("does not report a regression when nothing was added", async () => {
    itemFindMany.mockResolvedValue([row({ qaStatus: "QA_PASSED" })]);
    const result = await syncBatchRecord({ ...ARGS, prs: [pr()] });
    expect(result.regressed).toBe(false);
  });

  it("counts a dropped item as not blocking green", async () => {
    itemFindMany.mockResolvedValue([
      row({ qaStatus: "QA_PASSED" }),
      row({
        id: "item2",
        key: "pr:99",
        prNumber: 99,
        qaStatus: "QA_PENDING",
        droppedAt: new Date("2026-08-01"),
      }),
    ]);

    const result = await syncBatchRecord({
      ...ARGS,
      prs: [pr(), pr({ number: 102, mergeCommitSha: "bbb222" })],
    });

    expect(result.regressed).toBe(true);
  });

  it("adds the project's standing checks as their own items", async () => {
    await syncBatchRecord({
      ...ARGS,
      prs: [],
      standingChecks: ["Sign-in works", "Checkout completes"],
    });

    const keys = itemCreate.mock.calls.map((c) => c[0].data.key);
    expect(keys).toEqual([
      "standing:0:sign-in-works",
      "standing:1:checkout-completes",
    ]);
    expect(itemCreate.mock.calls[0][0].data.kind).toBe("CHECK");
  });
});

describe("markBatchShipped", () => {
  it("freezes the open batch and audits what it shipped", async () => {
    itemFindMany.mockResolvedValue([
      { qaStatus: "QA_PASSED", droppedAt: null },
      { qaStatus: "QA_PENDING", droppedAt: null },
    ]);

    await markBatchShipped({
      repoId: "repo1",
      projectId: "proj1",
      prNumber: 500,
      shippedAt: new Date("2026-08-28T09:00:00Z"),
    });

    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: "batch1" },
      data: {
        status: "SHIPPED",
        shippedAt: new Date("2026-08-28T09:00:00Z"),
        prNumber: 500,
      },
    });
    // Recorded even though it shipped one item short. Especially then.
    const payload = JSON.parse(auditCreate.mock.calls[0][0].data.payload);
    expect(payload).toMatchObject({ total: 2, passed: 1, resolved: 1 });
  });

  it("does nothing when the repo has no open batch", async () => {
    batchFindFirst.mockResolvedValue(null);
    await markBatchShipped({
      repoId: "repo1",
      projectId: "proj1",
      prNumber: 500,
      shippedAt: new Date(),
    });
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});
