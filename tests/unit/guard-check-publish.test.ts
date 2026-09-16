import { beforeEach, describe, expect, it, vi } from "vitest";

const prCheckFindUnique = vi.fn();
const prCheckUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    prCheck: {
      findUnique: (...a: unknown[]) => prCheckFindUnique(...a),
      update: (...a: unknown[]) => prCheckUpdate(...a),
    },
  },
}));

const upsertCheckRun = vi.fn();
const installationHasChecksWrite = vi.fn();
const findCheckRunIdByName = vi.fn();

vi.mock("@/lib/github/pr-actions", () => ({
  upsertCheckRun: (...a: unknown[]) => upsertCheckRun(...a),
  findCheckRunIdByName: (...a: unknown[]) => findCheckRunIdByName(...a),
  installationHasChecksWrite: (...a: unknown[]) =>
    installationHasChecksWrite(...a),
  repoRef: (fullName: string, installationId: number) => {
    const [owner, repo] = fullName.split("/");
    return { owner, repo, installationId };
  },
}));

import {
  publishGuardCheck,
  publishStandaloneGuardCheck,
  GUARD_CHECK_RUN_NAME,
} from "@/lib/github/check-run";
import type { GuardCheckPayload } from "@/lib/guard/render";

const PAYLOAD: GuardCheckPayload = {
  status: "completed",
  conclusion: "failure",
  title: "1 guarded file awaiting sign-off",
  summary: "…",
};

function args(over: Record<string, unknown> = {}) {
  return {
    installationId: 1,
    repoFullName: "acme/app",
    prCheckId: "prc1",
    headSha: "sha-head",
    project: { id: "p1", checksEnabled: true },
    payload: PAYLOAD,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installationHasChecksWrite.mockResolvedValue(true);
  upsertCheckRun.mockResolvedValue("run-1");
  prCheckFindUnique.mockResolvedValue(null);
  prCheckUpdate.mockResolvedValue({});
  findCheckRunIdByName.mockResolvedValue(null);
});

describe("publishGuardCheck", () => {
  it("publishes under the dedicated name and stores the run against its SHA", async () => {
    await publishGuardCheck(args());
    expect(upsertCheckRun).toHaveBeenCalledTimes(1);
    expect(upsertCheckRun.mock.calls[0][1]).toMatchObject({
      name: GUARD_CHECK_RUN_NAME,
      headSha: "sha-head",
      conclusion: "failure",
    });
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "prc1" },
      data: { guardCheckRunId: "run-1", guardCheckSha: "sha-head" },
    });
  });

  it("reuses the stored run while the SHA still matches", async () => {
    prCheckFindUnique.mockResolvedValue({
      guardCheckRunId: "run-1",
      guardCheckSha: "sha-head",
    });
    await publishGuardCheck(args());
    expect(upsertCheckRun.mock.calls[0][2]).toBe("run-1");
    // Nothing changed, so nothing is written back.
    expect(prCheckUpdate).not.toHaveBeenCalled();
  });

  // The bug this column exists to prevent: reusing a run id after a push
  // updates a check on a commit branch protection no longer reads, and leaves
  // the new head with no check at all, which GitHub reports as missing forever.
  it("creates a fresh run once the head has moved", async () => {
    prCheckFindUnique.mockResolvedValue({
      guardCheckRunId: "run-1",
      guardCheckSha: "sha-old",
    });
    upsertCheckRun.mockResolvedValue("run-2");
    await publishGuardCheck(args());
    expect(upsertCheckRun.mock.calls[0][2]).toBeNull();
    expect(prCheckUpdate).toHaveBeenCalledWith({
      where: { id: "prc1" },
      data: { guardCheckRunId: "run-2", guardCheckSha: "sha-head" },
    });
  });

  it("publishes for a PR with no tracked row, and stores nothing", async () => {
    await publishGuardCheck(args({ prCheckId: null }));
    expect(upsertCheckRun).toHaveBeenCalledTimes(1);
    expect(prCheckFindUnique).not.toHaveBeenCalled();
    expect(prCheckUpdate).not.toHaveBeenCalled();
  });

  it("publishes nothing when the project has checks off", async () => {
    await publishGuardCheck(
      args({ project: { id: "p1", checksEnabled: false } }),
    );
    expect(upsertCheckRun).not.toHaveBeenCalled();
    expect(installationHasChecksWrite).not.toHaveBeenCalled();
  });

  // The fourth state: no check rather than an error.
  it("publishes nothing when the installation lacks checks:write", async () => {
    installationHasChecksWrite.mockResolvedValue(false);
    await publishGuardCheck(args());
    expect(upsertCheckRun).not.toHaveBeenCalled();
  });

  it("publishes nothing without a head SHA", async () => {
    await publishGuardCheck(args({ headSha: null }));
    expect(upsertCheckRun).not.toHaveBeenCalled();
  });

  it("swallows a publish failure rather than crashing the handler", async () => {
    upsertCheckRun.mockRejectedValue(new Error("boom"));
    await expect(publishGuardCheck(args())).resolves.toBeUndefined();
  });
});

describe("publishStandaloneGuardCheck", () => {
  // The merge-queue SHA is transient: storing it would leave the PR's own
  // check unreachable, so the run standing on the commit is read instead.
  it("resolves the existing run by name and stores no id", async () => {
    findCheckRunIdByName.mockResolvedValue("queue-run");
    await publishStandaloneGuardCheck({
      installationId: 1,
      repoFullName: "acme/app",
      headSha: "queue-sha",
      project: { checksEnabled: true },
      payload: PAYLOAD,
    });
    expect(findCheckRunIdByName).toHaveBeenCalledWith(
      { owner: "acme", repo: "app", installationId: 1 },
      "queue-sha",
      GUARD_CHECK_RUN_NAME,
    );
    expect(upsertCheckRun.mock.calls[0][2]).toBe("queue-run");
    expect(prCheckUpdate).not.toHaveBeenCalled();
    expect(prCheckFindUnique).not.toHaveBeenCalled();
  });

  it("is gated on checks:write like its sibling", async () => {
    installationHasChecksWrite.mockResolvedValue(false);
    await publishStandaloneGuardCheck({
      installationId: 1,
      repoFullName: "acme/app",
      headSha: "queue-sha",
      project: { checksEnabled: true },
      payload: PAYLOAD,
    });
    expect(upsertCheckRun).not.toHaveBeenCalled();
  });
});
