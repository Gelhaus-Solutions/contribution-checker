import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/lib/env", () => ({
  env: { superAdmins: ["root-admin"], projectCreators: ["maker"] },
}));

import { seededRoles } from "@/lib/auth/sync-user";

describe("seededRoles", () => {
  it("makes a SUPER_ADMINS login a super-admin who can create projects, whatever its case", () => {
    expect(seededRoles("Root-Admin")).toEqual({ isSuperAdmin: true, canCreateProj: true });
  });

  it("lets a PROJECT_CREATORS login create projects and nothing more", () => {
    expect(seededRoles("maker")).toEqual({ isSuperAdmin: false, canCreateProj: true });
  });

  it("gives nothing to anybody else, or to an account without a login", () => {
    expect(seededRoles("someone")).toEqual({ isSuperAdmin: false, canCreateProj: false });
    expect(seededRoles(null)).toEqual({ isSuperAdmin: false, canCreateProj: false });
  });
});
