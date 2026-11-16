/**
 * Relink on the Repos page: a repo detached from its installation is linked
 * again with its row kept. Removing it and adding it back deleted
 * postiz-app's staging overrides and tracked release PR on 2026-11-15.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
const request = vi.fn();
const getInstallationOctokit = vi.fn(async () => ({ request }));
const recordAudit = vi.fn(async () => undefined);
const redirect = vi.fn((url: string) => {
  throw new Error(`redirect ${url}`);
});

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));
vi.mock("@/lib/authz", () => ({
  requireProjectRole: vi.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...(a as [])),
}));
vi.mock("@/lib/github/app", () => ({
  getAppSlug: vi.fn(async () => "postiz-contribution"),
  getInstallationOctokit: (...a: unknown[]) =>
    getInstallationOctokit(...(a as [])),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

import { relinkRepo } from "@/app/dashboard/projects/[id]/repos/actions";

const DETACHED = {
  id: "r1",
  projectId: "p1",
  fullName: "gitroomhq/postiz-app",
  installationId: null,
  detachedFromInstallationId: 129356052,
};

function form(): FormData {
  const f = new FormData();
  f.set("projectId", "p1");
  f.set("repoId", "r1");
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(DETACHED);
});

describe("relinkRepo", () => {
  it("links the row again when its installation still lists the repo", async () => {
    request.mockResolvedValue({
      data: { repositories: [{ id: 7, full_name: "gitroomhq/Postiz-App" }] },
    });
    await relinkRepo(form());
    expect(getInstallationOctokit).toHaveBeenCalledWith(
      129356052,
      { purpose: "repo-link", permissions: {} },
      "project:p1",
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: {
        installationId: 129356052,
        ghRepoId: 7,
        active: true,
        detachedFromInstallationId: null,
      },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repo.relinked", projectId: "p1" }),
    );
  });

  it("sends the admin to the App's installation page when the installation no longer has it", async () => {
    request.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    await expect(relinkRepo(form())).rejects.toThrow(
      "redirect https://github.com/apps/postiz-contribution/installations/new?state=p1",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves a repo that is linked, or was only entered by hand, alone", async () => {
    findUnique.mockResolvedValue({ ...DETACHED, detachedFromInstallationId: null });
    await relinkRepo(form());
    expect(getInstallationOctokit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("passes an outage on rather than treating it as an uninstall", async () => {
    request.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));
    await expect(relinkRepo(form())).rejects.toThrow("unavailable");
    expect(redirect).not.toHaveBeenCalled();
  });
});
