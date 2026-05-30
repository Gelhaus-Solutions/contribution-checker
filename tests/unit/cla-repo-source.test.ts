import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const repoFindUnique = vi.fn();
const repoFindMany = vi.fn();
const projectFindUnique = vi.fn();
const versionFindMany = vi.fn();
const pendingFindFirst = vi.fn();
const pendingCreate = vi.fn();
const pendingUpdate = vi.fn();
const pendingUpdateMany = vi.fn();
const octokitRequest = vi.fn();
const publishClaVersion = vi.fn();
const recordAudit = vi.fn();
const notifyProjectReviewers = vi.fn();
const onClaCoverageRevoked = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => repoFindUnique(...a),
      findMany: (...a: unknown[]) => repoFindMany(...a),
    },
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
    claDocumentVersion: {
      findMany: (...a: unknown[]) => versionFindMany(...a),
    },
    claPendingChange: {
      findFirst: (...a: unknown[]) => pendingFindFirst(...a),
      create: (...a: unknown[]) => pendingCreate(...a),
      update: (...a: unknown[]) => pendingUpdate(...a),
      updateMany: (...a: unknown[]) => pendingUpdateMany(...a),
    },
  },
}));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: async () => ({
    request: (...a: unknown[]) => octokitRequest(...a),
  }),
}));

vi.mock("@/lib/cla/mutations", () => ({
  publishClaVersion: (...a: unknown[]) => publishClaVersion(...a),
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...a),
}));

vi.mock("@/lib/notifications/inbox", () => ({
  notifyProjectReviewers: (...a: unknown[]) => notifyProjectReviewers(...a),
}));

vi.mock("@/lib/cla/post-sign", () => ({
  onClaCoverageRevoked: (...a: unknown[]) => onClaCoverageRevoked(...a),
}));

import { syncRepoFileClaForPush, syncClaRepoSourceNow } from "@/lib/cla/repo-source";

function contentRes(content: string, sha = "blob1") {
  return {
    data: {
      type: "file",
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
      sha,
    },
  };
}

const repoRow = {
  id: "repo1",
  fullName: "owner/r1",
  installationId: 11,
  project: {
    id: "proj1",
    claEnabled: true,
    claAutoVersionRequiresResign: false,
    claRepoFileReviewMode: false,
    currentIclaVersionId: "v1",
    currentCclaVersionId: null,
  },
};

function iclaVersion(contentHash: string) {
  return {
    id: "v1",
    kind: "ICLA",
    sourceType: "repo_file",
    sourceRepoId: "repo1",
    sourcePath: "CLA.md",
    sourceRef: "main",
    contentHash,
  };
}

beforeEach(() => {
  repoFindUnique.mockReset();
  repoFindMany.mockReset();
  projectFindUnique.mockReset();
  versionFindMany.mockReset();
  pendingFindFirst.mockReset();
  pendingCreate.mockReset();
  pendingUpdate.mockReset();
  pendingUpdateMany.mockReset();
  octokitRequest.mockReset();
  publishClaVersion.mockReset();
  recordAudit.mockReset();
  notifyProjectReviewers.mockReset();
  onClaCoverageRevoked.mockReset();
  recordAudit.mockResolvedValue(undefined);
  notifyProjectReviewers.mockResolvedValue(undefined);
  onClaCoverageRevoked.mockResolvedValue(undefined);
  pendingFindFirst.mockResolvedValue(null);
  pendingCreate.mockResolvedValue({ id: "pc1" });
  pendingUpdate.mockResolvedValue(undefined);
  pendingUpdateMany.mockResolvedValue(undefined);
  publishClaVersion.mockResolvedValue({
    id: "v2",
    version: 2,
    contentHash: "new",
    affectedGhIds: [],
  });
});

describe("syncRepoFileClaForPush", () => {
  it("publishes a new version when the tracked file changed", async () => {
    repoFindUnique.mockResolvedValueOnce(repoRow);
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    octokitRequest.mockResolvedValueOnce(contentRes("new CLA text"));

    const result = await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(result.published).toEqual([{ kind: "ICLA", version: 2 }]);
    expect(publishClaVersion).toHaveBeenCalledTimes(1);
    expect(publishClaVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj1",
        kind: "ICLA",
        sourceType: "repo_file",
        bodyMarkdown: "new CLA text",
        requireResign: false,
        actorUserId: null,
      })
    );
    expect(recordAudit).toHaveBeenCalled();
    expect(notifyProjectReviewers).not.toHaveBeenCalled();
  });

  it("is a no-op when the fetched content is unchanged", async () => {
    const text = "same CLA text";
    const hash = createHash("sha256").update(text).digest("hex");
    repoFindUnique.mockResolvedValueOnce(repoRow);
    versionFindMany.mockResolvedValueOnce([iclaVersion(hash)]);
    octokitRequest.mockResolvedValueOnce(contentRes(text));

    const result = await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(result.published).toEqual([]);
    expect(publishClaVersion).not.toHaveBeenCalled();
  });

  it("skips when the push didn't touch the tracked path", async () => {
    repoFindUnique.mockResolvedValueOnce(repoRow);
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);

    const result = await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["src/index.ts"]),
    });

    expect(result.published).toEqual([]);
    expect(octokitRequest).not.toHaveBeenCalled();
    expect(publishClaVersion).not.toHaveBeenCalled();
  });

  it("skips when the push is on a different branch than the CLA source ref", async () => {
    repoFindUnique.mockResolvedValueOnce(repoRow);
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);

    const result = await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "feature",
      defaultBranch: "main",
      changedPaths: null,
    });

    expect(result.published).toEqual([]);
    expect(octokitRequest).not.toHaveBeenCalled();
  });

  it("notifies reviewers to re-sign when auto-version requires re-sign", async () => {
    repoFindUnique.mockResolvedValueOnce({
      ...repoRow,
      project: { ...repoRow.project, claAutoVersionRequiresResign: true },
    });
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    octokitRequest.mockResolvedValueOnce(contentRes("new CLA text"));

    await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(publishClaVersion).toHaveBeenCalledWith(
      expect.objectContaining({ requireResign: true })
    );
    expect(notifyProjectReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.resign_required" })
    );
  });

  it("re-gates affected contributors after an auto-resign publish", async () => {
    repoFindUnique.mockResolvedValueOnce({
      ...repoRow,
      project: { ...repoRow.project, claAutoVersionRequiresResign: true },
    });
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    octokitRequest.mockResolvedValueOnce(contentRes("new CLA text"));
    publishClaVersion.mockResolvedValueOnce({
      id: "v2",
      version: 2,
      contentHash: "new",
      affectedGhIds: [42, 43],
    });

    await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(onClaCoverageRevoked).toHaveBeenCalledWith({
      projectId: "proj1",
      ghIds: [42, 43],
    });
  });

  it("creates a pending change instead of publishing in review mode", async () => {
    repoFindUnique.mockResolvedValueOnce({
      ...repoRow,
      project: { ...repoRow.project, claRepoFileReviewMode: true },
    });
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    octokitRequest.mockResolvedValueOnce(contentRes("new CLA text"));

    const result = await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(result.published).toEqual([]);
    expect(publishClaVersion).not.toHaveBeenCalled();
    expect(pendingCreate).toHaveBeenCalledTimes(1);
    expect(notifyProjectReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.pending_change" })
    );
  });

  it("refreshes the single PENDING row in review mode rather than creating duplicates", async () => {
    repoFindUnique.mockResolvedValueOnce({
      ...repoRow,
      project: { ...repoRow.project, claRepoFileReviewMode: true },
    });
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    octokitRequest.mockResolvedValueOnce(contentRes("newer CLA text"));
    pendingFindFirst.mockResolvedValueOnce({ id: "pc-existing" });

    await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(pendingCreate).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pc-existing" } })
    );
  });

  it("supersedes a stale PENDING row when content reverts to the published hash", async () => {
    const text = "same CLA text";
    const hash = createHash("sha256").update(text).digest("hex");
    repoFindUnique.mockResolvedValueOnce({
      ...repoRow,
      project: { ...repoRow.project, claRepoFileReviewMode: true },
    });
    versionFindMany.mockResolvedValueOnce([iclaVersion(hash)]);
    octokitRequest.mockResolvedValueOnce(contentRes(text));

    await syncRepoFileClaForPush({
      ghRepoId: 99,
      branch: "main",
      defaultBranch: "main",
      changedPaths: new Set(["CLA.md"]),
    });

    expect(pendingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING" }),
        data: expect.objectContaining({ status: "SUPERSEDED" }),
      })
    );
  });
});

describe("syncClaRepoSourceNow", () => {
  const baseProject = {
    id: "proj1",
    claAutoVersionRequiresResign: false,
    claRepoFileReviewMode: false,
    currentIclaVersionId: "v1",
    currentCclaVersionId: null,
  };

  it("reports no-op when the live file matches the stored hash", async () => {
    const text = "same CLA text";
    const hash = createHash("sha256").update(text).digest("hex");
    projectFindUnique.mockResolvedValueOnce(baseProject);
    versionFindMany.mockResolvedValueOnce([iclaVersion(hash)]);
    repoFindMany.mockResolvedValueOnce([
      { id: "repo1", fullName: "owner/r1", installationId: 11 },
    ]);
    octokitRequest.mockResolvedValueOnce(contentRes(text));

    const { results } = await syncClaRepoSourceNow({ projectId: "proj1" });

    expect(results).toEqual([{ kind: "ICLA", status: "unchanged" }]);
    expect(publishClaVersion).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cla.repo_sync_run" })
    );
  });

  it("publishes when the live file changed (auto mode)", async () => {
    projectFindUnique.mockResolvedValueOnce(baseProject);
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    repoFindMany.mockResolvedValueOnce([
      { id: "repo1", fullName: "owner/r1", installationId: 11 },
    ]);
    octokitRequest.mockResolvedValueOnce(contentRes("new CLA text"));

    const { results } = await syncClaRepoSourceNow({ projectId: "proj1" });

    expect(results).toEqual([{ kind: "ICLA", status: "published", version: 2 }]);
    expect(publishClaVersion).toHaveBeenCalledTimes(1);
  });

  it("reports an error when the source repo has no installation", async () => {
    projectFindUnique.mockResolvedValueOnce(baseProject);
    versionFindMany.mockResolvedValueOnce([iclaVersion("oldhash")]);
    repoFindMany.mockResolvedValueOnce([
      { id: "repo1", fullName: "owner/r1", installationId: null },
    ]);

    const { results } = await syncClaRepoSourceNow({ projectId: "proj1" });

    expect(results[0].status).toBe("error");
    expect(octokitRequest).not.toHaveBeenCalled();
  });
});
