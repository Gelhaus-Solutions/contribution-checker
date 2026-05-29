import { describe, expect, it, vi, beforeEach } from "vitest";

const projectFindUnique = vi.fn();
const waiverFindFirst = vi.fn();
const signatureFindFirst = vi.fn();
const rosterFindFirst = vi.fn();

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
      findFirst: (...args: unknown[]) => rosterFindFirst(...args),
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
  rosterFindFirst.mockReset();

  // Default: floors at 1 for both kinds; nothing on file.
  projectFindUnique.mockResolvedValue({ minIclaVersion: 1, minCclaVersion: 1 });
  waiverFindFirst.mockResolvedValue(null);
  signatureFindFirst.mockResolvedValue(null);
  rosterFindFirst.mockResolvedValue(null);
});

const who = { projectId: "proj1", ghId: 42, ghLogin: "Octocat" };

describe("getClaStatus", () => {
  it("is satisfied via an active waiver (short-circuits other checks)", async () => {
    waiverFindFirst.mockResolvedValueOnce({ id: "w1" });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "waiver" });
    // Waiver wins before signature/roster are queried.
    expect(signatureFindFirst).not.toHaveBeenCalled();
    expect(rosterFindFirst).not.toHaveBeenCalled();
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
    expect(rosterFindFirst).not.toHaveBeenCalled();
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
    // A stale ICLA is terminal — roster is not consulted as a fallback.
    expect(rosterFindFirst).not.toHaveBeenCalled();
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
    rosterFindFirst.mockResolvedValueOnce({
      id: "m1",
      corporateCla: {
        id: "corp1",
        companyName: "Acme Inc",
        status: "ACTIVE",
        signature: { documentVersion: 2 },
      },
    });

    const res = await getClaStatus(who);

    expect(res).toEqual({
      satisfied: true,
      via: "ccla",
      corporate: { id: "corp1", companyName: "Acme Inc" },
    });
  });

  it("matches the roster member by ghId or lowercased ghLogin", async () => {
    rosterFindFirst.mockResolvedValueOnce(null);

    await getClaStatus(who);

    expect(rosterFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "proj1",
        status: "ACTIVE",
        OR: [{ ghId: 42 }, { ghLogin: "octocat" }],
      },
      include: { corporateCla: { include: { signature: true } } },
    });
  });

  it("is not satisfied when the corporate is REVOKED", async () => {
    rosterFindFirst.mockResolvedValueOnce({
      id: "m1",
      corporateCla: {
        id: "corp1",
        companyName: "Acme Inc",
        status: "REVOKED",
        signature: { documentVersion: 5 },
      },
    });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when the signatory's CCLA version is stale", async () => {
    projectFindUnique.mockResolvedValueOnce({
      minIclaVersion: 1,
      minCclaVersion: 3,
    });
    rosterFindFirst.mockResolvedValueOnce({
      id: "m1",
      corporateCla: {
        id: "corp1",
        companyName: "Acme Inc",
        status: "ACTIVE",
        signature: { documentVersion: 2 },
      },
    });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when there is no active roster member (REVOKED/DISPUTED filtered by query)", async () => {
    // The query filters status:"ACTIVE", so a REVOKED/DISPUTED member returns
    // null here; coverage is therefore not granted.
    rosterFindFirst.mockResolvedValueOnce(null);

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
    rosterFindFirst.mockResolvedValue(null);

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
