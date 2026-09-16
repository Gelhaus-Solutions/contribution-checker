import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
  },
}));

import { assertLabelsUnique, LABEL_COLUMNS } from "@/lib/labels";

const CURRENT = {
  labelPending: "contribution:pending",
  labelApproved: "contribution:approved",
  labelDenied: "contribution:denied",
  labelEvaluate: "contribution:evaluate",
  labelStagingBatch: "staging:batch",
  labelStagingIgnore: "staging:ignore",
  labelStagingRepoint: "staging:repoint",
  qaFailedLabel: "qa:failed",
  labelGuardUnlock: "guard:approved",
  labelGuardBlocked: "guard:blocked",
};

beforeEach(() => {
  vi.clearAllMocks();
  projectFindUnique.mockResolvedValue(CURRENT);
});

describe("assertLabelsUnique", () => {
  it("accepts the defaults unchanged", async () => {
    await expect(assertLabelsUnique("p1", {})).resolves.toBeUndefined();
  });

  it("accepts a rename that stays distinct", async () => {
    await expect(
      assertLabelsUnique("p1", { labelGuardUnlock: "signed-off" }),
    ).resolves.toBeUndefined();
  });

  it("rejects two submitted labels colliding with each other", async () => {
    await expect(
      assertLabelsUnique("p1", {
        labelGuardUnlock: "same",
        labelGuardBlocked: "same",
      }),
    ).rejects.toThrow(/already used/);
  });

  // The failure this exists to prevent: one form converging on a name another
  // form owns, after which one of the two features stops finding its own PRs.
  it("rejects a collision with a label edited on another form", async () => {
    await expect(
      assertLabelsUnique("p1", { labelGuardUnlock: "staging:batch" }),
    ).rejects.toThrow(/staging batch label/);
  });

  // GitHub label names are case-insensitive, so storing both would produce
  // exactly the silent collision this is here to stop.
  it("rejects a collision that differs only in case", async () => {
    await expect(
      assertLabelsUnique("p1", { labelGuardUnlock: "QA:Failed" }),
    ).rejects.toThrow(/already used/);
  });

  it("names every label column the bot owns", () => {
    expect(LABEL_COLUMNS).toHaveLength(Object.keys(CURRENT).length);
    for (const column of LABEL_COLUMNS) {
      expect(CURRENT).toHaveProperty(column);
    }
  });

  it("throws for a project that is not there", async () => {
    projectFindUnique.mockResolvedValue(null);
    await expect(assertLabelsUnique("nope", {})).rejects.toThrow(
      "Project not found",
    );
  });
});
