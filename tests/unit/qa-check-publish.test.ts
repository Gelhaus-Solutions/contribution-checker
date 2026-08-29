import { beforeEach, describe, expect, it, vi } from "vitest";

const batchFindUnique = vi.fn();
const batchUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    stagingBatch: {
      findUnique: (...a: unknown[]) => batchFindUnique(...a),
      update: (...a: unknown[]) => batchUpdate(...a),
    },
  },
}));

const upsertCheckRun = vi.fn();
const installationHasChecksWrite = vi.fn();

vi.mock("@/lib/github/pr-actions", () => ({
  upsertCheckRun: (...a: unknown[]) => upsertCheckRun(...a),
  installationHasChecksWrite: (...a: unknown[]) =>
    installationHasChecksWrite(...a),
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
}));

import { publishQaCheck } from "@/lib/github/check-run";

const PROJECT = { id: "p1", checksEnabled: true, qaCheckEnabled: true };

function args(headSha: string | null) {
  return {
    installationId: 1,
    repoFullName: "acme/app",
    batchId: "batch1",
    headSha,
    project: PROJECT,
    items: [
      {
        key: "pr:101",
        kind: "PR",
        prNumber: 101,
        title: "Add a thing",
        authorLogin: "octocat",
        qaStatus: "QA_PENDING",
        qaNotes: null,
        droppedAt: null,
      },
    ],
    boardUrl: "https://example.test/qa",
  };
}

describe("publishQaCheck head-sha binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installationHasChecksWrite.mockResolvedValue(true);
    upsertCheckRun.mockResolvedValue("999");
  });

  it("creates a run and remembers the sha it belongs to", async () => {
    batchFindUnique.mockResolvedValue({ qaCheckRunId: null, qaCheckSha: null });
    await publishQaCheck(args("sha-a"));

    expect(upsertCheckRun).toHaveBeenCalledTimes(1);
    expect(upsertCheckRun.mock.calls[0][2]).toBeNull();
    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: "batch1" },
      data: { qaCheckRunId: "999", qaCheckSha: "sha-a" },
    });
  });

  it("reuses the stored run while the head is unchanged", async () => {
    batchFindUnique.mockResolvedValue({
      qaCheckRunId: "999",
      qaCheckSha: "sha-a",
    });
    await publishQaCheck(args("sha-a"));

    expect(upsertCheckRun.mock.calls[0][2]).toBe("999");
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  // The bug: a check run cannot be moved to another commit, so PATCHing the
  // stored id after a push to staging updated an invisible run and left the new
  // head with no QA check, which branch protection reports as missing.
  it("creates a fresh run when the batch head moved", async () => {
    batchFindUnique.mockResolvedValue({
      qaCheckRunId: "999",
      qaCheckSha: "sha-a",
    });
    upsertCheckRun.mockResolvedValue("1000");
    await publishQaCheck(args("sha-b"));

    expect(upsertCheckRun.mock.calls[0][2]).toBeNull();
    expect(upsertCheckRun.mock.calls[0][1].headSha).toBe("sha-b");
    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: "batch1" },
      data: { qaCheckRunId: "1000", qaCheckSha: "sha-b" },
    });
  });

  it("publishes nothing without a head sha", async () => {
    await publishQaCheck(args(null));
    expect(upsertCheckRun).not.toHaveBeenCalled();
  });
});
