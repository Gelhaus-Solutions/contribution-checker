import { describe, expect, it, vi, beforeEach } from "vitest";

const eventLogFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    claEventLog: {
      findMany: (...args: unknown[]) => eventLogFindMany(...args),
    },
  },
}));

import {
  GENESIS_PREV,
  canonicalJson,
  computeEntryHash,
  appendClaEvent,
  verifyChain,
  type ChainKind,
} from "@/lib/cla/integrity";

beforeEach(() => {
  eventLogFindMany.mockReset();
});

/**
 * Minimal in-memory transaction client that mirrors the bits of
 * `Prisma.TransactionClient` that `appendClaEvent` touches:
 * `claEventLog.findFirst` (max seq, desc) and `claEventLog.create`.
 */
type Row = {
  id: string;
  projectId: string;
  seq: number;
  kind: string;
  payload: string;
  actorUserId: string | null;
  actorGhId: number | null;
  signatureId: string | null;
  documentVersionId: string | null;
  rosterMemberId: string | null;
  corporateId: string | null;
  waiverId: string | null;
  prevHash: string;
  entryHash: string;
};

function makeFakeTx() {
  const rows: Row[] = [];
  let n = 0;
  const tx = {
    claEventLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) => {
        const matching = rows
          .filter((r) => r.projectId === args.where.projectId)
          .sort((a, b) => b.seq - a.seq);
        return matching[0] ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (args: any) => {
        const data = args.data;
        const row: Row = {
          id: `row-${n++}`,
          projectId: data.projectId,
          seq: data.seq,
          kind: data.kind,
          payload: data.payload,
          actorUserId: data.actorUserId ?? null,
          actorGhId: data.actorGhId ?? null,
          signatureId: data.signatureId ?? null,
          documentVersionId: data.documentVersionId ?? null,
          rosterMemberId: data.rosterMemberId ?? null,
          corporateId: data.corporateId ?? null,
          waiverId: data.waiverId ?? null,
          prevHash: data.prevHash,
          entryHash: data.entryHash,
        };
        rows.push(row);
        return { id: row.id };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tx: tx as any, rows };
}

describe("canonicalJson", () => {
  it("sorts object keys so output is independent of insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts keys recursively in nested objects", () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, first: true });
    const b = canonicalJson({ first: true, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"first":true,"outer":{"a":2,"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("sorts keys of objects inside arrays but keeps element order", () => {
    const out = canonicalJson([
      { b: 1, a: 2 },
      { d: 4, c: 3 },
    ]);
    expect(out).toBe('[{"a":2,"b":1},{"c":3,"d":4}]');
  });

  it("handles null and primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
  });

  it("drops undefined-valued object keys (mirroring JSON.stringify)", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("computeEntryHash", () => {
  it("is deterministic for equal inputs", () => {
    const args = {
      seq: 1,
      projectId: "p1",
      kind: "icla.signed" as ChainKind,
      prevHash: "abc",
      payload: { ghId: 7, ghLogin: "octocat" },
    };
    expect(computeEntryHash(args)).toBe(computeEntryHash(args));
  });

  it("is independent of payload key insertion order", () => {
    const base = {
      seq: 2,
      projectId: "p1",
      kind: "doc.published" as ChainKind,
      prevHash: "deadbeef",
    };
    const h1 = computeEntryHash({
      ...base,
      payload: { version: 1, kind: "ICLA", hash: "zz" },
    });
    const h2 = computeEntryHash({
      ...base,
      payload: { hash: "zz", kind: "ICLA", version: 1 },
    });
    expect(h1).toBe(h2);
  });

  it("changes when any hashed field changes", () => {
    const base = {
      seq: 1,
      projectId: "p1",
      kind: "icla.signed" as ChainKind,
      prevHash: "abc",
      payload: { x: 1 },
    };
    const h = computeEntryHash(base);
    expect(computeEntryHash({ ...base, seq: 2 })).not.toBe(h);
    expect(computeEntryHash({ ...base, projectId: "p2" })).not.toBe(h);
    expect(
      computeEntryHash({ ...base, kind: "ccla.signed" as ChainKind })
    ).not.toBe(h);
    expect(computeEntryHash({ ...base, prevHash: "xyz" })).not.toBe(h);
    expect(computeEntryHash({ ...base, payload: { x: 2 } })).not.toBe(h);
  });

  it("produces a 64-char hex sha256 digest", () => {
    const h = computeEntryHash({
      seq: 0,
      projectId: "p1",
      kind: "genesis",
      prevHash: GENESIS_PREV,
      payload: { projectId: "p1" },
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("appendClaEvent", () => {
  it("writes a genesis entry then the real event on an empty chain", async () => {
    const { tx, rows } = makeFakeTx();
    const res = await appendClaEvent({
      tx,
      projectId: "p1",
      kind: "icla.signed",
      payload: { ghId: 7 },
      actorUserId: "u1",
      actorGhId: 7,
      links: { signatureId: "sig1" },
    });

    expect(rows).toHaveLength(2);

    const genesis = rows[0];
    expect(genesis.seq).toBe(0);
    expect(genesis.kind).toBe("genesis");
    expect(genesis.prevHash).toBe(GENESIS_PREV);
    expect(JSON.parse(genesis.payload)).toEqual({ projectId: "p1" });

    const real = rows[1];
    expect(real.seq).toBe(1);
    expect(real.kind).toBe("icla.signed");
    expect(real.prevHash).toBe(genesis.entryHash);
    expect(real.actorUserId).toBe("u1");
    expect(real.actorGhId).toBe(7);
    expect(real.signatureId).toBe("sig1");

    // Returns the real entry, not the genesis one.
    expect(res.seq).toBe(1);
    expect(res.entryHash).toBe(real.entryHash);
    expect(res.id).toBe(real.id);
  });

  it("chains subsequent events off the prior entryHash without re-genesis", async () => {
    const { tx, rows } = makeFakeTx();
    const first = await appendClaEvent({
      tx,
      projectId: "p1",
      kind: "icla.signed",
      payload: { a: 1 },
    });
    const second = await appendClaEvent({
      tx,
      projectId: "p1",
      kind: "doc.published",
      payload: { b: 2 },
    });

    expect(rows).toHaveLength(3); // genesis + 2
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(rows[2].prevHash).toBe(first.entryHash);
  });

  it("does not include a timestamp in the entry hash", async () => {
    const { tx, rows } = makeFakeTx();
    await appendClaEvent({
      tx,
      projectId: "p1",
      kind: "waiver.granted",
      payload: { ghLogin: "octocat" },
    });
    const real = rows[1];
    const recomputed = computeEntryHash({
      seq: real.seq,
      projectId: "p1",
      kind: "waiver.granted",
      prevHash: real.prevHash,
      payload: JSON.parse(real.payload),
    });
    expect(recomputed).toBe(real.entryHash);
  });
});

/**
 * Build a valid chain of length n (1 genesis + extra events) as stored rows,
 * suitable for the `verifyChain` findMany mock.
 */
function buildValidChain(
  projectId: string,
  events: { kind: ChainKind; payload: unknown }[]
) {
  const rows: {
    seq: number;
    kind: string;
    payload: string;
    prevHash: string;
    entryHash: string;
  }[] = [];

  const genesisPayload = { projectId };
  const genesisHash = computeEntryHash({
    seq: 0,
    projectId,
    kind: "genesis",
    prevHash: GENESIS_PREV,
    payload: genesisPayload,
  });
  rows.push({
    seq: 0,
    kind: "genesis",
    payload: JSON.stringify(genesisPayload),
    prevHash: GENESIS_PREV,
    entryHash: genesisHash,
  });

  let prev = genesisHash;
  events.forEach((ev, idx) => {
    const seq = idx + 1;
    const entryHash = computeEntryHash({
      seq,
      projectId,
      kind: ev.kind,
      prevHash: prev,
      payload: ev.payload,
    });
    rows.push({
      seq,
      kind: ev.kind,
      payload: JSON.stringify(ev.payload),
      prevHash: prev,
      entryHash,
    });
    prev = entryHash;
  });

  return rows;
}

describe("verifyChain", () => {
  it("verifies an empty chain as ok with no head", async () => {
    eventLogFindMany.mockResolvedValueOnce([]);
    const res = await verifyChain("p1");
    expect(res).toEqual({ ok: true, entries: 0, head: null });
  });

  it("verifies a hand-built valid chain", async () => {
    const rows = buildValidChain("p1", [
      { kind: "icla.signed", payload: { ghId: 7, ghLogin: "octocat" } },
      { kind: "doc.published", payload: { version: 1 } },
    ]);
    eventLogFindMany.mockResolvedValueOnce(rows);

    const res = await verifyChain("p1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entries).toBe(3);
      expect(res.head).toBe(rows[rows.length - 1].entryHash);
    }
  });

  it("detects a tampered payload at the affected seq", async () => {
    const rows = buildValidChain("p1", [
      { kind: "icla.signed", payload: { ghId: 7 } },
      { kind: "doc.published", payload: { version: 1 } },
    ]);
    // Mutate the payload of seq 1 without recomputing its hash.
    rows[1].payload = JSON.stringify({ ghId: 9999 });
    eventLogFindMany.mockResolvedValueOnce(rows);

    const res = await verifyChain("p1");
    expect(res).toEqual({ ok: false, brokenAtSeq: 1, reason: "hash_mismatch" });
  });

  it("detects a tampered seq as a gap", async () => {
    const rows = buildValidChain("p1", [
      { kind: "icla.signed", payload: { ghId: 7 } },
      { kind: "doc.published", payload: { version: 1 } },
    ]);
    // Renumber the second event from seq 2 to seq 3 -> breaks contiguity.
    rows[2].seq = 3;
    eventLogFindMany.mockResolvedValueOnce(rows);

    const res = await verifyChain("p1");
    expect(res).toEqual({ ok: false, brokenAtSeq: 3, reason: "gap" });
  });

  it("detects a broken prevHash linkage", async () => {
    const rows = buildValidChain("p1", [
      { kind: "icla.signed", payload: { ghId: 7 } },
      { kind: "doc.published", payload: { version: 1 } },
    ]);
    // Break the link of seq 2: point prevHash somewhere else, and recompute
    // its own entryHash so it is internally consistent (isolating prev_mismatch).
    rows[2].prevHash = "not-the-prior-hash";
    rows[2].entryHash = computeEntryHash({
      seq: 2,
      projectId: "p1",
      kind: rows[2].kind as ChainKind,
      prevHash: rows[2].prevHash,
      payload: JSON.parse(rows[2].payload),
    });
    eventLogFindMany.mockResolvedValueOnce(rows);

    const res = await verifyChain("p1");
    expect(res).toEqual({ ok: false, brokenAtSeq: 2, reason: "prev_mismatch" });
  });

  it("detects a missing genesis (first entry not seq 0 genesis)", async () => {
    const rows = buildValidChain("p1", [
      { kind: "icla.signed", payload: { ghId: 7 } },
    ]);
    // Drop the genesis row; chain now starts at seq 1.
    const without = rows.slice(1);
    eventLogFindMany.mockResolvedValueOnce(without);

    const res = await verifyChain("p1");
    expect(res).toEqual({
      ok: false,
      brokenAtSeq: 1,
      reason: "missing_genesis",
    });
  });

  it("detects genesis with wrong prevHash", async () => {
    const rows = buildValidChain("p1", []);
    rows[0].prevHash = "not-genesis";
    eventLogFindMany.mockResolvedValueOnce(rows);

    const res = await verifyChain("p1");
    expect(res).toEqual({
      ok: false,
      brokenAtSeq: 0,
      reason: "missing_genesis",
    });
  });
});
