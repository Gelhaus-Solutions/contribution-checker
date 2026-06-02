import { describe, expect, it, vi, beforeEach } from "vitest";

// resolve-user is server-only and pulls in recordSignInMetric (which imports the
// Hexclave SDK + the server-only stack module). Stub both so we can unit-test
// the lazy-link branching with a mocked prisma.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/sync-user", () => ({ recordSignInMetric: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const userCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
      update: (...args: unknown[]) => userUpdate(...args),
      create: (...args: unknown[]) => userCreate(...args),
    },
  },
}));

import { resolveLocalUserFromStack } from "@/lib/auth/resolve-user";
import { recordSignInMetric } from "@/lib/auth/sync-user";

const stackUser = {
  id: "stack_123",
  primaryEmail: "octocat@example.com",
  displayName: "Octo Cat",
  profileImageUrl: "https://avatars/x.png",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveLocalUserFromStack", () => {
  it("returns the row already linked by stackUserId without writing", async () => {
    const row = { id: "u1", stackUserId: "stack_123" };
    userFindUnique.mockResolvedValueOnce(row); // by stackUserId

    const result = await resolveLocalUserFromStack(stackUser);

    expect(result).toBe(row);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(recordSignInMetric).not.toHaveBeenCalled();
  });

  it("lazy-links an unlinked row matched by email", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by stackUserId
      .mockResolvedValueOnce({ id: "u2", stackUserId: null }); // by email
    const linked = { id: "u2", stackUserId: "stack_123" };
    userUpdate.mockResolvedValueOnce(linked);

    const result = await resolveLocalUserFromStack(stackUser);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u2" },
      data: { stackUserId: "stack_123" },
    });
    expect(result).toBe(linked);
    expect(userCreate).not.toHaveBeenCalled();
    expect(recordSignInMetric).toHaveBeenCalledWith(false);
  });

  it("creates a minimal row when no match exists", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by stackUserId
      .mockResolvedValueOnce(null) // by email (link attempt)
      .mockResolvedValueOnce(null); // by email (free-check before create)
    const created = { id: "u3", stackUserId: "stack_123" };
    userCreate.mockResolvedValueOnce(created);

    const result = await resolveLocalUserFromStack(stackUser);

    expect(userCreate).toHaveBeenCalledWith({
      data: {
        stackUserId: "stack_123",
        email: "octocat@example.com",
        name: "Octo Cat",
        image: "https://avatars/x.png",
      },
    });
    expect(result).toBe(created);
    expect(recordSignInMetric).toHaveBeenCalledWith(true);
  });

  it("creates without email when the email is already taken", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by stackUserId
      .mockResolvedValueOnce(null) // by email (link attempt: no unlinked row)
      .mockResolvedValueOnce({ id: "other", stackUserId: "stack_other" }); // by email (taken)
    userCreate.mockResolvedValueOnce({ id: "u4", stackUserId: "stack_123" });

    await resolveLocalUserFromStack(stackUser);

    expect(userCreate).toHaveBeenCalledWith({
      data: {
        stackUserId: "stack_123",
        email: null,
        name: "Octo Cat",
        image: "https://avatars/x.png",
      },
    });
  });
});
