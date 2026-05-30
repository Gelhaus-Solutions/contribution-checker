import { describe, expect, it, vi, beforeEach } from "vitest";

const waiverFindFirst = vi.fn();
const signatureFindFirst = vi.fn();
const rosterFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
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
  waiverFindFirst.mockReset();
  signatureFindFirst.mockReset();
  rosterFindMany.mockReset();

  // Default: nothing on file.
  waiverFindFirst.mockResolvedValue(null);
  signatureFindFirst.mockResolvedValue(null);
  rosterFindMany.mockResolvedValue([]);
});

const who = { projectId: "proj1", ghId: 42, ghLogin: "Octocat" };

// A CCLA roster member shape with a signatory signature on a version with the
// given resignRequired flag.
function member(opts: {
  id: string;
  corpId: string;
  company: string;
  corpStatus: string;
  resignRequired: boolean;
}) {
  return {
    id: opts.id,
    corporateCla: {
      id: opts.corpId,
      companyName: opts.company,
      status: opts.corpStatus,
      signature: { version: { resignRequired: opts.resignRequired } },
    },
  };
}

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

  it("is satisfied via an ICLA on a non-stale version", async () => {
    // First query (valid filter) finds a signature on a resignRequired=false version.
    signatureFindFirst.mockResolvedValueOnce({ id: "s1" });

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: true, via: "icla" });
    expect(rosterFindMany).not.toHaveBeenCalled();
  });

  it("queries for any ACTIVE ICLA signature on a non-stale version first", async () => {
    signatureFindFirst.mockResolvedValueOnce({ id: "s1" });

    await getClaStatus(who);

    expect(signatureFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        projectId: "proj1",
        ghId: 42,
        kind: "ICLA",
        status: "ACTIVE",
        version: { is: { resignRequired: false } },
      },
      select: { id: true },
    });
  });

  it("is stale (needsResign) when every ICLA signature is on a resignRequired version", async () => {
    // No valid signature, but an ACTIVE ICLA signature exists -> must re-sign.
    signatureFindFirst
      .mockResolvedValueOnce(null) // valid-version query
      .mockResolvedValueOnce({ id: "s1" }); // any-signature query

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false, via: "icla", needsResign: true });
    // A stale ICLA is terminal: roster is not consulted as a fallback.
    expect(rosterFindMany).not.toHaveBeenCalled();
    expect(signatureFindFirst).toHaveBeenNthCalledWith(2, {
      where: { projectId: "proj1", ghId: 42, kind: "ICLA", status: "ACTIVE" },
      select: { id: true },
    });
  });

  it("is satisfied via an active roster member under an active corporate", async () => {
    rosterFindMany.mockResolvedValueOnce([
      member({
        id: "m1",
        corpId: "corp1",
        company: "Acme Inc",
        corpStatus: "ACTIVE",
        resignRequired: false,
      }),
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
      include: {
        corporateCla: {
          include: {
            signature: { include: { version: { select: { resignRequired: true } } } },
          },
        },
      },
    });
  });

  it("is covered by an ACTIVE corporate even when also on a non-active roster", async () => {
    // A contributor on several rosters: a REVOKED corporate and an ACTIVE one.
    // The active one must win (regression against the old findFirst behavior).
    rosterFindMany.mockResolvedValueOnce([
      member({
        id: "revoked-member",
        corpId: "corpRevoked",
        company: "Old Co",
        corpStatus: "REVOKED",
        resignRequired: false,
      }),
      member({
        id: "active-member",
        corpId: "corpActive",
        company: "Acme Inc",
        corpStatus: "ACTIVE",
        resignRequired: false,
      }),
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({
      satisfied: true,
      via: "ccla",
      corporate: { id: "corpActive", companyName: "Acme Inc" },
    });
  });

  it("is not satisfied when only a PENDING corporate covers the contributor", async () => {
    rosterFindMany.mockResolvedValueOnce([
      member({
        id: "m1",
        corpId: "corp1",
        company: "Acme Inc",
        corpStatus: "PENDING",
        resignRequired: false,
      }),
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when the corporate is REVOKED", async () => {
    rosterFindMany.mockResolvedValueOnce([
      member({
        id: "m1",
        corpId: "corp1",
        company: "Acme Inc",
        corpStatus: "REVOKED",
        resignRequired: false,
      }),
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when the signatory's CCLA version is stale (resignRequired)", async () => {
    rosterFindMany.mockResolvedValueOnce([
      member({
        id: "m1",
        corpId: "corp1",
        company: "Acme Inc",
        corpStatus: "ACTIVE",
        resignRequired: true,
      }),
    ]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied when there is no active roster membership", async () => {
    rosterFindMany.mockResolvedValueOnce([]);

    const res = await getClaStatus(who);

    expect(res).toEqual({ satisfied: false });
  });

  it("is not satisfied with nothing on file", async () => {
    const res = await getClaStatus(who);
    expect(res).toEqual({ satisfied: false });
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
    // Cached: waiver queried only once.
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
