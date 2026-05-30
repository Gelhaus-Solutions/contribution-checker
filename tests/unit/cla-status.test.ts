import { describe, expect, it, vi, beforeEach } from "vitest";

const projectFindUnique = vi.fn();
const waiverFindFirst = vi.fn();
const signatureFindFirst = vi.fn();
const rosterFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findUnique: (...args: unknown[]) => projectFindUnique(...args),
    },
    claWaiver: {
      findFirst: (...args: unknown[]) => waiverFindFirst(...args),
    },
    claSignature: {
      findFirst: (...args: unknown[]) => signatureFindFirst(...args),
    },
    cclaRosterMember: {
      findMany: (...args: unknown[]) => rosterFindMany(...args),
    },
  },
}));

import {
  getClaStatus,
  isClaSatisfied,
  invalidateClaCache,
} from "@/lib/cla/status";

beforeEach(() => {
  projectFindUnique.mockReset();
  waiverFindFirst.mockReset();
  signatureFindFirst.mockReset();
  rosterFindMany.mockReset();

  // Default: floors at 1 for both kinds; nothing on file.
  projectFindUnique.mockResolvedValue({ minIclaVersion: 1, minCclaVersion: 1 });
  waiverFindFirst.mockResolvedValue(null);
  signatureFindFirst.mockResolvedValue(null);
  rosterFindMany.mockResolvedValue([]);
});

const who = { projectId: "proj1", ghId: 42, ghLogin: "Octocat" };

describe("getClaStatus", () => {
  it("is satisfied via an active waiver (short-circuits other checks)", async () => {
    waiverFindFirst.mockResolvedValueOnce({ id: "w1" });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "waiver" });
    // Waiver wins before signature/roster are queried.
    expect(signatureFindFirst).not.toHaveBeenCalled();
    expect(rosterFindMany).not.toHaveBeenCalled();
  });

  it("matches the waiver by ghId or lowercased ghLogin", async () => {
    waiverFindFirst.mockResolvedValueOnce({ id: "w1" });

    await getClaStatus(who);

    expect(waiverFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "proj1",
        status: "ACTIVE",
        OR: [{ ghId: 42 }, { ghLogin: "octocat" }],
      },
      select: { id: true },
    });
  });

  it("is satisfied via ICLA at the minimum version", async () => {
    signatureFindFirst.mockResolvedValueOnce({ documentVersion: 1 });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "icla" });
    expect(rosterFindMany).not.toHaveBeenCalled();
  });

  it("is satisfied via ICLA above the minimum version", async () => {
    signatureFindFirst.mockResolvedValueOnce({ documentVersion: 3 });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "icla" });
  });

  it("is stale (needsResign, not satisfied) when the ICLA is below the minimum", async () => {
    projectFindUnique.mockResolvedValueOnce({
      minIclaVersion: 2,
      minCclaVersion: 1,
    });
    signatureFindFirst.mockResolvedValueOnce({ documentVersion: 1 });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false, via: "icla", needsResign: true });
    // A stale ICLA is terminal: roster is not consulted as a fallback.
    expect(rosterFindMany).not.toHaveBeenCalled();
  });

  it("queries the newest active ICLA signature for this ghId", async () => {
    signatureFindFirst.mockResolvedValueOnce({ documentVersion: 5 });

    await getClaStatus(who);

    expect(signatureFindFirst).toHaveBeenCalledWith({
      where: { projectId: "proj1", ghId: 42, kind: "ICLA", status: "ACTIVE" },
      orderBy: { documentVersion: "desc" },
      select: { documentVersion: true },
    });
  });

  it("is satisfied via an active roster member under an active corporate", async () => {
    rosterFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        corporateCla: {
          id: "corp1",
          companyName: "Acme Inc",
          status: "ACTIVE",
          signature: { documentVersion: 2 },
        },
      },
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({
      satisfied: true,
      via: "ccla",
      corporate: { id: "corp1", companyName: "Acme Inc" },
    });
  });

  it("only considers memberships under an ACTIVE corporate (relation filter)", async () => {
    rosterFindMany.mockResolvedValueOnce([]);

    await getClaStatus(who);

    expect(rosterFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj1",
        status: "ACTIVE",
        OR: [{ ghId: 42 }, { ghLogin: "octocat" }],
        corporateCla: { is: { status: "ACTIVE" } },
      },
      include: { corporateCla: { include: { signature: true } } },
    });
  });

  it("is covered by an ACTIVE corporate even when also on a non-active roster", async () => {
    // A contributor on several rosters: a REVOKED corporate and an ACTIVE one.
    // The active one must win (regression against the old findFirst behavior).
    rosterFindMany.mockResolvedValueOnce([
      {
        id: "revoked-member",
        corporateCla: {
          id: "corpRevoked",
          companyName: "Old Co",
          status: "REVOKED",
          signature: { documentVersion: 5 },
        },
      },
      {
        id: "active-member",
        corporateCla: {
          id: "corpActive",
          companyName: "Acme Inc",
          status: "ACTIVE",
          signature: { documentVersion: 2 },
        },
      },
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({
      satisfied: true,
      via: "ccla",
      corporate: { id: "corpActive", companyName: "Acme Inc" },
    });
  });

  it("is not satisfied when only a PENDING corporate covers the contributor", async () => {
    // PENDING corporates are excluded by the relation filter at the DB; the JS
    // guard is the belt-and-suspenders for the same condition.
    rosterFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        corporateCla: {
          id: "corp1",
          companyName: "Acme Inc",
          status: "PENDING",
          signature: { documentVersion: 5 },
        },
      },
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when the corporate is REVOKED", async () => {
    rosterFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        corporateCla: {
          id: "corp1",
          companyName: "Acme Inc",
          status: "REVOKED",
          signature: { documentVersion: 5 },
        },
      },
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when the signatory's CCLA version is stale", async () => {
    projectFindUnique.mockResolvedValueOnce({
      minIclaVersion: 1,
      minCclaVersion: 3,
    });
    rosterFindMany.mockResolvedValueOnce([
      {
        id: "m1",
        corporateCla: {
          id: "corp1",
          companyName: "Acme Inc",
          status: "ACTIVE",
          signature: { documentVersion: 2 },
        },
      },
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when there is no active roster membership", async () => {
    // The query filters status:"ACTIVE" and an ACTIVE corporate, so a
    // REVOKED/DISPUTED member (or a member under a non-active corporate) returns
    // nothing; coverage is therefore not granted.
    rosterFindMany.mockResolvedValueOnce([]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied with nothing on file", async () => {
    const res = await getClaStatus(who);
    expect(res).toEqual({ satisfied: false });
  });

  it("treats missing min-version columns as 0", async () => {
    projectFindUnique.mockResolvedValueOnce(null);
    signatureFindFirst.mockResolvedValueOnce({ documentVersion: 0 });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "icla" });
  });
});

describe("isClaSatisfied + cache", () => {
  it("returns the boolean and caches it (no second DB read)", async () => {
    waiverFindFirst.mockResolvedValueOnce({ id: "w1" });

    const first = await isClaSatisfied({
      projectId: "cacheProj",
      ghId: 7,
      ghLogin: "user",
    });
    const second = await isClaSatisfied({
      projectId: "cacheProj",
      ghId: 7,
      ghLogin: "user",
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Cached: project + waiver each queried only once.
    expect(projectFindUnique).toHaveBeenCalledTimes(1);
    expect(waiverFindFirst).toHaveBeenCalledTimes(1);
  });

  it("re-queries after invalidateClaCache", async () => {
    waiverFindFirst.mockResolvedValue(null);
    signatureFindFirst.mockResolvedValue(null);
    rosterFindMany.mockResolvedValue([]);

    const before = await isClaSatisfied({
      projectId: "invProj",
      ghId: 9,
      ghLogin: "user",
    });
    expect(before).toBe(false);

    invalidateClaCache("invProj", 9);

    // Now a waiver is granted; the cache must not mask it.
    waiverFindFirst.mockResolvedValueOnce({ id: "w2" });
    const after = await isClaSatisfied({
      projectId: "invProj",
      ghId: 9,
      ghLogin: "user",
    });

    expect(after).toBe(true);
    expect(waiverFindFirst).toHaveBeenCalledTimes(2);
  });
});
