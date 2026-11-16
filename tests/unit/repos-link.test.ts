/**
 * The Link page: a repo unselected there is detached from the installation,
 * so the Repos page offers Relink and the installation does not link it again
 * by itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const update = vi.fn();
const create = vi.fn();
const recordAudit = vi.fn(async () => undefined);

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findMany: (...a: unknown[]) => findMany(...a),
      update: (...a: unknown[]) => update(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));
vi.mock("@/lib/authz", () => ({
  requireProjectRole: vi.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...(a as [])),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { linkRepos } from "@/app/dashboard/projects/[id]/repos/link/actions";

const INSTALLATION_ID = 129356052;

function form(selected: string[]) {
  const f = new FormData();
  f.set("projectId", "p1");
  f.set("installationId", String(INSTALLATION_ID));
  for (const s of selected) f.append("ghRepoIds", s);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([
    {
      id: "r1",
      ghRepoId: 7,
      fullName: "gitroomhq/postiz-app",
      installationId: INSTALLATION_ID,
    },
    {
      id: "r2",
      ghRepoId: 8,
      fullName: "gitroomhq/postiz-docs",
      installationId: INSTALLATION_ID,
    },
  ]);
});

describe("linkRepos", () => {
  it("detaches a repo unselected on the Link page from the installation", async () => {
    await linkRepos(form(["7|gitroomhq/postiz-app"]));
    expect(update).toHaveBeenCalledWith({
      where: { id: "r2" },
      data: {
        installationId: null,
        ghRepoId: null,
        detachedFromInstallationId: INSTALLATION_ID,
      },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repo.unlinked" }),
    );
  });

  it("keeps a selected repo linked and clears a detachment", async () => {
    await linkRepos(
      form(["7|gitroomhq/postiz-app", "8|gitroomhq/postiz-docs"]),
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: "r2" },
      data: {
        fullName: "gitroomhq/postiz-docs",
        ghRepoId: 8,
        installationId: INSTALLATION_ID,
        active: true,
        detachedFromInstallationId: null,
      },
    });
  });
});
