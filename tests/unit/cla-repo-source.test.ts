import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const repoFindUnique = vi.fn();
const versionFindMany = vi.fn();
const octokitRequest = vi.fn();
const publishClaVersion = vi.fn();
const recordAudit = vi.fn();
const notifyProjectReviewers = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    claDocumentVersion: {
      findMany: (...a: unknown[]) => versionFindMany(...a),
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

import { syncRepoFileClaForPush } from "@/lib/cla/repo-source";

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
  versionFindMany.mockReset();
  octokitRequest.mockReset();
  publishClaVersion.mockReset();
  recordAudit.mockReset();
  notifyProjectReviewers.mockReset();
  recordAudit.mockResolvedValue(undefined);
  notifyProjectReviewers.mockResolvedValue(undefined);
  publishClaVersion.mockResolvedValue({ id: "v2", version: 2, contentHash: "new" });
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
});
