import { describe, expect, it, vi, beforeEach } from "vitest";

// resolve-user is server-only and pulls in the GitHub profile fetch, the
// sign-in metric and the terms push. Stub them so the binding rules can be
// exercised against a mocked prisma.
vi.mock("server-only", () => ({}));
const fetchGithubUserById = vi.fn();
const seededRoles = vi.fn();
vi.mock("@/lib/auth/sync-user", () => ({
  recordSignInMetric: vi.fn(),
  fetchGithubUserById: (...args: unknown[]) => fetchGithubUserById(...args),
  seededRoles: (...args: unknown[]) => seededRoles(...args),
}));
vi.mock("@/lib/gpterms", () => ({ pushAccount: vi.fn() }));
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

import {
  AccountConflict,
  githubLinkOf,
  resolveLocalUser,
  type GpidPerson,
} from "@/lib/auth/resolve-user";
import { recordSignInMetric } from "@/lib/auth/sync-user";
import { pushAccount } from "@/lib/gpterms";

const person: GpidPerson = {
  subject: "sub_123",
  email: "octocat@example.com",
  displayName: "Octo Cat",
  github: { ghId: 583231, ghLogin: "octocat" },
};

beforeEach(() => {
  vi.clearAllMocks();
  seededRoles.mockReturnValue({ isSuperAdmin: false, canCreateProj: false });
  fetchGithubUserById.mockResolvedValue({
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    email: null,
    avatar_url: "https://avatars.githubusercontent.com/u/583231",
  });
});

describe("githubLinkOf", () => {
  it("reads GitHub's numeric id and login off the links", () => {
    expect(
      githubLinkOf({
        links: [
          { provider: "google", accountId: "g-1", login: null },
          { provider: "github", accountId: "583231", login: "octocat" },
        ],
      }),
    ).toEqual({ ghId: 583231, ghLogin: "octocat" });
  });

  it("is null without a GitHub link, or with an id that is not GitHub's kind", () => {
    expect(githubLinkOf({})).toBeNull();
    expect(githubLinkOf({ links: [] })).toBeNull();
    expect(githubLinkOf({ links: [{ provider: "github", accountId: "abc", login: "x" }] })).toBeNull();
    expect(githubLinkOf({ links: [{ provider: "github", accountId: "-4", login: "x" }] })).toBeNull();
  });
});

describe("resolveLocalUser", () => {
  it("returns the row already bound to the subject without writing", async () => {
    const row = { id: "u1", ssoSubject: "sub_123", ghId: 583231, ghLogin: "octocat" };
    userFindUnique.mockResolvedValueOnce(row);

    expect(await resolveLocalUser(person)).toBe(row);
    expect(userFindUnique).toHaveBeenCalledWith({ where: { ssoSubject: "sub_123" } });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("follows a GitHub rename on the bound row", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "u1", ssoSubject: "sub_123", ghId: 583231, ghLogin: "old-name" });
    userUpdate.mockResolvedValueOnce({ id: "u1", ghLogin: "octocat" });

    await resolveLocalUser(person);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { ghLogin: "octocat" } });
  });

  it("never rewrites a row's GitHub id to another account's", async () => {
    const row = { id: "u1", ssoSubject: "sub_123", ghId: 1, ghLogin: "someone" };
    userFindUnique.mockResolvedValueOnce(row);

    expect(await resolveLocalUser(person)).toBe(row);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("binds a row from before the move by its GitHub id", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by subject
      .mockResolvedValueOnce({ id: "u2", ssoSubject: null, ghId: 583231, ghLogin: "octocat" }); // by GitHub id
    userUpdate.mockResolvedValueOnce({ id: "u2", ssoSubject: "sub_123" });

    const result = await resolveLocalUser(person);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u2" }, data: { ssoSubject: "sub_123" } });
    expect(result).toEqual({ id: "u2", ssoSubject: "sub_123" });
    expect(recordSignInMetric).toHaveBeenCalledWith(false);
  });

  it("refuses a GitHub account another subject already holds here", async () => {
    userFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "u2", ssoSubject: "sub_other", ghId: 583231 });

    await expect(resolveLocalUser(person)).rejects.toBeInstanceOf(AccountConflict);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("binds a row by address only when it names no other GitHub account", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by subject
      .mockResolvedValueOnce(null) // by GitHub id
      .mockResolvedValueOnce({ id: "u3", ssoSubject: null, ghId: null, ghLogin: null }); // by email
    userUpdate.mockResolvedValueOnce({ id: "u3" });

    await resolveLocalUser(person);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u3" },
      data: { ssoSubject: "sub_123", ghId: 583231, ghLogin: "octocat" },
    });
  });

  it("creates a new row with the GitHub identity, the profile and the seeded roles", async () => {
    userFindUnique
      .mockResolvedValueOnce(null) // by subject
      .mockResolvedValueOnce(null) // by GitHub id
      .mockResolvedValueOnce({ id: "other", ssoSubject: "sub_x", ghId: 9 }) // by email: someone else's
      .mockResolvedValueOnce({ id: "other" }) // email still taken
      .mockResolvedValueOnce(null); // login free
    seededRoles.mockReturnValueOnce({ isSuperAdmin: true, canCreateProj: true });
    const created = { id: "u4", ssoSubject: "sub_123" };
    userCreate.mockResolvedValueOnce(created);

    expect(await resolveLocalUser(person)).toBe(created);
    expect(userCreate).toHaveBeenCalledWith({
      data: {
        ssoSubject: "sub_123",
        email: null,
        name: "The Octocat",
        image: "https://avatars.githubusercontent.com/u/583231",
        ghId: 583231,
        ghLogin: "octocat",
        isSuperAdmin: true,
        canCreateProj: true,
      },
    });
    expect(seededRoles).toHaveBeenCalledWith("octocat");
    expect(recordSignInMetric).toHaveBeenCalledWith(true);
    expect(pushAccount).toHaveBeenCalledWith(created);
  });

  it("re-reads the row when a concurrent request created it first", async () => {
    userFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null) // by email
      .mockResolvedValueOnce(null) // email free
      .mockResolvedValueOnce(null) // login free
      .mockResolvedValueOnce({ id: "u5", ssoSubject: "sub_123" }); // after the race
    userCreate.mockRejectedValueOnce(new Error("Unique constraint failed on ssoSubject"));

    expect(await resolveLocalUser(person)).toEqual({ id: "u5", ssoSubject: "sub_123" });
  });
});
