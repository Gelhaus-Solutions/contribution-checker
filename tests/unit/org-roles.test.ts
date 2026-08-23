import { describe, expect, it, vi, beforeEach } from "vitest";

// sync-user is server-only and reaches the Hexclave SDK through @/lib/stack.
// Stub the module graph so resolveOrgRoles can be exercised against a fake
// ServerUser.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: vi.fn() } } }));
vi.mock("@sentry/nextjs", () => ({ metrics: { count: vi.fn() } }));
vi.mock("@/lib/stack", () => ({
  getStackServerApp: vi.fn(),
  SUPER_ADMIN_PERMISSION: "super_admin",
  CREATE_PROJECT_PERMISSION: "create_project",
  GITHUB_PROVIDER_CONFIG_ID: "github",
  GITHUB_OAUTH_SCOPES: ["read:user", "user:email"],
}));

const isInstanceAdminTeam = vi.fn();
vi.mock("@/lib/stack-provisioning", () => ({
  isInstanceAdminTeam: (...args: unknown[]) => isInstanceAdminTeam(...args),
}));

import { resolveOrgRoles } from "@/lib/auth/sync-user";

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Minimal ServerUser stand-in: resolveOrgRoles only reads these three. */
function fakeUser(opts: {
  getPermission?: (id: string) => Promise<unknown>;
  listTeams?: () => Promise<unknown>;
}) {
  return {
    id: "stack_1",
    getPermission: opts.getPermission ?? (async () => null),
    listTeams: opts.listTeams ?? (async () => []),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  isInstanceAdminTeam.mockReturnValue(false);
});

describe("resolveOrgRoles", () => {
  it("issues the two permission reads and the team read concurrently", async () => {
    // All three are held open at once; if any were awaited in sequence the
    // later ones would never start and this would time out.
    const gates = [deferred(), deferred(), deferred()];
    let permissionCalls = 0;

    const promise = resolveOrgRoles(
      fakeUser({
        getPermission: async () => {
          const gate = gates[permissionCalls++];
          await gate.promise;
          return null;
        },
        listTeams: async () => {
          await gates[2].promise;
          return [];
        },
      }),
    );

    // Yield so all three fetchers reach their gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(permissionCalls).toBe(2);

    gates.forEach((g) => g.resolve(null));
    await expect(promise).resolves.toEqual({
      isSuperAdmin: false,
      canCreateProj: false,
    });
  });

  it("keeps a permission that resolved when its sibling read throws", async () => {
    const roles = await resolveOrgRoles(
      fakeUser({
        getPermission: async (id: string) => {
          if (id === "create_project") throw new Error("hexclave down");
          return { id };
        },
      }),
    );

    // super_admin survived its sibling's failure, and still implies creation.
    expect(roles).toEqual({ isSuperAdmin: true, canCreateProj: true });
  });

  it("keeps the permission reads when the team read throws", async () => {
    const roles = await resolveOrgRoles(
      fakeUser({
        getPermission: async (id: string) =>
          id === "create_project" ? { id } : null,
        listTeams: async () => {
          throw new Error("hexclave down");
        },
      }),
    );

    expect(roles).toEqual({ isSuperAdmin: false, canCreateProj: true });
  });

  it("grants super-admin from Instance Admin team membership alone", async () => {
    isInstanceAdminTeam.mockImplementation(
      (team: { id: string }) => team.id === "team_admin",
    );

    const roles = await resolveOrgRoles(
      fakeUser({ listTeams: async () => [{ id: "team_other" }, { id: "team_admin" }] }),
    );

    expect(roles).toEqual({ isSuperAdmin: true, canCreateProj: true });
  });

  it("degrades to no privileges when every read fails", async () => {
    const roles = await resolveOrgRoles(
      fakeUser({
        getPermission: async () => {
          throw new Error("hexclave down");
        },
        listTeams: async () => {
          throw new Error("hexclave down");
        },
      }),
    );

    expect(roles).toEqual({ isSuperAdmin: false, canCreateProj: false });
  });
});
