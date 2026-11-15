/**
 * The App's installation events. A suspension (GMint's lockdown suspends every
 * installation) must not unlink the repos, and an unsuspend links again what an
 * older suspend unlinked and re-gates the open PRs, because GitHub sends no
 * events while an installation is suspended (the lockdown of 2026-11-14).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repoUpdateMany = vi.fn();
const repoFindFirst = vi.fn();
const repoFindMany = vi.fn();
const reGateProjectPrs = vi.fn();
const request = vi.fn();
const getInstallationOctokit = vi.fn(async () => ({ request }));

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      updateMany: (...a: unknown[]) => repoUpdateMany(...a),
      findFirst: (...a: unknown[]) => repoFindFirst(...a),
      findMany: (...a: unknown[]) => repoFindMany(...a),
    },
  },
}));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: (...a: unknown[]) =>
    getInstallationOctokit(...(a as [])),
}));

vi.mock("@/lib/temporal/start", () => ({
  reGateProjectPrs: (...a: unknown[]) => reGateProjectPrs(...a),
  signalStagingBatch: vi.fn(),
}));

import { handleInstallationEvent } from "@/lib/github/webhook";

const INSTALLATION = { id: 129356052, account: { login: "gitroomhq" } };

beforeEach(() => {
  vi.clearAllMocks();
  repoUpdateMany.mockResolvedValue({ count: 1 });
  repoFindMany.mockResolvedValue([{ projectId: "p1" }]);
});

describe("handleInstallationEvent", () => {
  it("keeps the repos linked when the installation is suspended", async () => {
    await handleInstallationEvent({
      action: "suspend",
      installation: INSTALLATION,
    });
    expect(repoUpdateMany).not.toHaveBeenCalled();
    expect(reGateProjectPrs).not.toHaveBeenCalled();
  });

  it("still unlinks the repos when the App is uninstalled", async () => {
    await handleInstallationEvent({
      action: "deleted",
      installation: INSTALLATION,
    });
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: { installationId: INSTALLATION.id },
      data: { installationId: null, ghRepoId: null },
    });
  });

  it("re-gates the installation's projects after an unsuspend", async () => {
    repoFindFirst.mockResolvedValue(null);
    await handleInstallationEvent({
      action: "unsuspend",
      installation: INSTALLATION,
    });
    expect(getInstallationOctokit).not.toHaveBeenCalled();
    expect(reGateProjectPrs).toHaveBeenCalledWith({
      projectId: "p1",
      reason: "installation unsuspended",
    });
  });

  it("links again, from the installation's own list, the repos an older suspend unlinked", async () => {
    repoFindFirst.mockResolvedValue({ projectId: "p1" });
    request.mockResolvedValue({
      data: {
        repositories: [{ id: 7, full_name: "gitroomhq/postiz-app" }],
      },
    });
    await handleInstallationEvent({
      action: "unsuspend",
      installation: INSTALLATION,
    });
    expect(getInstallationOctokit).toHaveBeenCalledWith(
      INSTALLATION.id,
      { purpose: "repo-link", permissions: {} },
      "project:p1",
    );
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: { fullName: "gitroomhq/postiz-app", installationId: null },
      data: { ghRepoId: 7, installationId: INSTALLATION.id, active: true },
    });
    expect(reGateProjectPrs).toHaveBeenCalledTimes(1);
  });
});
