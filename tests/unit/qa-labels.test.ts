import { beforeEach, describe, expect, it, vi } from "vitest";

const batchFindUnique = vi.fn();
const batchUpdate = vi.fn();
const itemFindMany = vi.fn();
const itemUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    stagingBatch: {
      findUnique: (...a: unknown[]) => batchFindUnique(...a),
      update: (...a: unknown[]) => batchUpdate(...a),
    },
    stagingBatchItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      update: (...a: unknown[]) => itemUpdate(...a),
    },
  },
}));

const ensureLabel = vi.fn();
const addLabel = vi.fn();
const removeLabelIfPresent = vi.fn();

vi.mock("@/lib/github/pr-actions", () => ({
  ensureLabel: (...a: unknown[]) => ensureLabel(...a),
  addLabel: (...a: unknown[]) => addLabel(...a),
  removeLabelIfPresent: (...a: unknown[]) => removeLabelIfPresent(...a),
}));

import { syncQaLabels } from "@/lib/qa/labels";

const REF = { owner: "acme", repo: "app", installationId: 1 };
const ARGS = {
  ref: REF,
  batchId: "batch1",
  failedLabel: "qa:failed",
  aggregatePrNumber: 500,
};

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "item1",
    prNumber: 101,
    qaStatus: "QA_PENDING",
    qaLabelApplied: false,
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of [
    batchFindUnique,
    batchUpdate,
    itemFindMany,
    itemUpdate,
    ensureLabel,
    addLabel,
    removeLabelIfPresent,
  ]) {
    m.mockReset();
  }
  batchFindUnique.mockResolvedValue({ qaLabelApplied: false });
  batchUpdate.mockResolvedValue({});
  itemFindMany.mockResolvedValue([]);
  itemUpdate.mockResolvedValue({});
  ensureLabel.mockResolvedValue(undefined);
  addLabel.mockResolvedValue(undefined);
  removeLabelIfPresent.mockResolvedValue(undefined);
});

describe("syncQaLabels", () => {
  it("costs no API calls when nothing changed", async () => {
    // The property that keeps a reconcile on every push to staging from costing
    // one or two label calls per PR in the batch, every time.
    itemFindMany.mockResolvedValue([item(), item({ id: "item2", prNumber: 102 })]);

    await syncQaLabels(ARGS);

    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabelIfPresent).not.toHaveBeenCalled();
    expect(ensureLabel).not.toHaveBeenCalled();
  });

  it("labels the failed PR and the aggregate PR", async () => {
    itemFindMany.mockResolvedValue([item({ qaStatus: "QA_FAILED" })]);

    await syncQaLabels(ARGS);

    expect(ensureLabel).toHaveBeenCalledTimes(1);
    expect(addLabel).toHaveBeenCalledWith(REF, 101, "qa:failed");
    expect(addLabel).toHaveBeenCalledWith(REF, 500, "qa:failed");
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item1" },
      data: { qaLabelApplied: true },
    });
    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: "batch1" },
      data: { qaLabelApplied: true },
    });
  });

  it("removes the label when the failure clears", async () => {
    batchFindUnique.mockResolvedValue({ qaLabelApplied: true });
    itemFindMany.mockResolvedValue([
      item({ qaStatus: "QA_PASSED", qaLabelApplied: true }),
    ]);

    await syncQaLabels(ARGS);

    expect(removeLabelIfPresent).toHaveBeenCalledWith(REF, 101, "qa:failed");
    expect(removeLabelIfPresent).toHaveBeenCalledWith(REF, 500, "qa:failed");
    // The label tracks the current state rather than accumulating.
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: "item1" },
      data: { qaLabelApplied: false },
    });
  });

  it("keeps the aggregate label while any other item is still failed", async () => {
    batchFindUnique.mockResolvedValue({ qaLabelApplied: true });
    itemFindMany.mockResolvedValue([
      item({ qaStatus: "QA_PASSED", qaLabelApplied: true }),
      item({ id: "item2", prNumber: 102, qaStatus: "QA_FAILED", qaLabelApplied: true }),
    ]);

    await syncQaLabels(ARGS);

    expect(removeLabelIfPresent).toHaveBeenCalledWith(REF, 101, "qa:failed");
    expect(removeLabelIfPresent).not.toHaveBeenCalledWith(REF, 500, "qa:failed");
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it("leaves the flag unset when the label call failed, so the next pass retries", async () => {
    addLabel.mockRejectedValue(new Error("rate limited"));
    itemFindMany.mockResolvedValue([item({ qaStatus: "QA_FAILED" })]);

    await syncQaLabels(ARGS);

    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it("ignores standing checks, which have no PR to label", async () => {
    itemFindMany.mockResolvedValue([
      item({ prNumber: null, qaStatus: "QA_FAILED" }),
    ]);

    await syncQaLabels(ARGS);

    // The aggregate PR still carries it: the batch has a failure in it.
    expect(addLabel).toHaveBeenCalledWith(REF, 500, "qa:failed");
    expect(addLabel).toHaveBeenCalledTimes(1);
  });
});
