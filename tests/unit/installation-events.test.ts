/**
 * The App's installation events. A suspension (GMint's lockdown suspends every
 * installation) must not unlink the repos, and an unsuspend links again what an
 * older suspend unlinked and re-gates the open PRs, because GitHub sends no
 * events while an installation is suspended (the lockdown of 2026-11-14). A
 * repo taken off the installation stays off until it is put back or relinked.
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

import {
  handleInstallationEvent,
  handleInstallationReposEvent,
} from "@/lib/github/webhook";

const INSTALLATION = { id: 129356052, account: { login: "gitroomhq" } };
const LINKED = {
  ghRepoId: 7,
  installationId: INSTALLATION.id,
  active: true,
  detachedFromInstallationId: null,
};
const NOT_DETACHED_FROM_IT = {
  OR: [
    { detachedFromInstallationId: null },
    { detachedFromInstallationId: { not: INSTALLATION.id } },
  ],
};

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
      data: {
        installationId: null,
        ghRepoId: null,
        detachedFromInstallationId: INSTALLATION.id,
      },
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
      where: {
        fullName: "gitroomhq/postiz-app",
        installationId: null,
        ...NOT_DETACHED_FROM_IT,
      },
      data: LINKED,
    });
    expect(reGateProjectPrs).toHaveBeenCalledTimes(1);
  });

  it("leaves a repo taken off the installation unlinked when new permissions are accepted", async () => {
    await handleInstallationEvent({
      action: "new_permissions_accepted",
      installation: INSTALLATION,
      repositories: [{ id: 7, full_name: "gitroomhq/postiz-app" }],
    });
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: {
        fullName: "gitroomhq/postiz-app",
        installationId: null,
        ...NOT_DETACHED_FROM_IT,
      },
      data: LINKED,
    });
  });

  it("links a detached repo again when the App is installed again", async () => {
    await handleInstallationEvent({
      action: "created",
      installation: INSTALLATION,
      repositories: [{ id: 7, full_name: "gitroomhq/postiz-app" }],
    });
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: { fullName: "gitroomhq/postiz-app", installationId: null },
      data: LINKED,
    });
  });
});

describe("handleInstallationReposEvent", () => {
  it("links a repo again when it is put back on the installation", async () => {
    await handleInstallationReposEvent({
      action: "added",
      installation: INSTALLATION,
      repositories_added: [{ id: 7, full_name: "gitroomhq/postiz-app" }],
    });
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: { fullName: "gitroomhq/postiz-app", installationId: null },
      data: LINKED,
    });
  });

  it("remembers the installation of a repo taken off it, so it can be relinked", async () => {
    await handleInstallationReposEvent({
      action: "removed",
      installation: INSTALLATION,
      repositories_removed: [{ id: 7, full_name: "gitroomhq/postiz-app" }],
    });
    expect(repoUpdateMany).toHaveBeenCalledWith({
      where: { ghRepoId: { in: [7] }, installationId: INSTALLATION.id },
      data: {
        installationId: null,
        ghRepoId: null,
        detachedFromInstallationId: INSTALLATION.id,
      },
    });
  });
});
