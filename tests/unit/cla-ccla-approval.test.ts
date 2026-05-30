import { describe, expect, it, vi, beforeEach } from "vitest";

// Shared, hoisted in-memory state for the fake transaction client. The mutations
// run inside `prisma.$transaction(fn)`; our mock invokes `fn` with a tx that
// reads/writes these stores and drives the real `appendClaEvent` ledger logic.
const h = vi.hoisted(() => {
  type CorporateRow = {
    id: string;
    projectId: string;
    status: string;
    companyName: string;
    signature: { userId: string | null };
    members: { ghId: number | null; status: string }[];
    approvedById?: string | null;
    approvedAt?: Date | null;
    rejectedById?: string | null;
    rejectedAt?: Date | null;
    rejectReason?: string | null;
  };
  const corporates = new Map<string, CorporateRow>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger: any[] = [];
  let n = 0;

  const makeTx = () => ({
    corporateCla: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async (args: any) => {
        const row = corporates.get(args.where.id);
        if (!row) return null;
        const sel = args.select ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out: any = {};
        if (sel.id) out.id = row.id;
        if (sel.projectId) out.projectId = row.projectId;
        if (sel.status) out.status = row.status;
        if (sel.companyName) out.companyName = row.companyName;
        if (sel.signature) out.signature = { userId: row.signature.userId };
        if (sel.members) {
          out.members = row.members
            .filter((m) => m.status === "ACTIVE")
            .map((m) => ({ ghId: m.ghId }));
        }
        return out;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async (args: any) => {
        const row = corporates.get(args.where.id)!;
        Object.assign(row, args.data);
        return row;
      },
    },
    claEventLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) => {
        const matching = ledger
          .filter((r) => r.projectId === args.where.projectId)
          .sort((a, b) => b.seq - a.seq);
        return matching[0] ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (args: any) => {
        const row = { id: `row-${n++}`, ...args.data };
        ledger.push(row);
        return { id: row.id };
      },
    },
  });

  return { corporates, ledger, makeTx };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: (fn: any) => fn(h.makeTx()),
    claEventLog: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) =>
        h.ledger
          .filter((r) => r.projectId === args.where.projectId)
          .sort((a, b) => a.seq - b.seq)
          .map((r) => ({
            seq: r.seq,
            kind: r.kind,
            payload: r.payload,
            prevHash: r.prevHash,
            entryHash: r.entryHash,
          })),
    },
  },
}));

import { approveCorporateCla, rejectCorporateCla } from "@/lib/cla/mutations";
import { verifyChain } from "@/lib/cla/integrity";
import { parseChainPayload } from "@/lib/cla/schema";

beforeEach(() => {
  h.corporates.clear();
  h.ledger.length = 0;
});

function seedPending(over?: Partial<{ status: string }>) {
  h.corporates.set("corp1", {
    id: "corp1",
    projectId: "proj1",
    status: over?.status ?? "PENDING",
    companyName: "Acme Inc",
    signature: { userId: "signer1" },
    members: [
      { ghId: 42, status: "ACTIVE" },
      { ghId: null, status: "ACTIVE" },
      { ghId: 99, status: "REVOKED" },
    ],
  });
}

describe("approveCorporateCla", () => {
  it("flips PENDING to ACTIVE, stamps approver, and appends a ccla.approved event", async () => {
    seedPending();

    const res = await approveCorporateCla({
      corporateId: "corp1",
      actorUserId: "admin1",
    });

    expect(res.projectId).toBe("proj1");
    expect(res.companyName).toBe("Acme Inc");
    expect(res.signatoryUserId).toBe("signer1");
    // Only ACTIVE members with a known ghId are returned for re-check.
    expect(res.activeMemberGhIds).toEqual([42]);

    const row = h.corporates.get("corp1")!;
    expect(row.status).toBe("ACTIVE");
    expect(row.approvedById).toBe("admin1");
    expect(row.approvedAt).toBeInstanceOf(Date);

    const approved = h.ledger.find((r) => r.kind === "ccla.approved");
    expect(approved).toBeTruthy();
    expect(approved.corporateId).toBe("corp1");
    const parsed = parseChainPayload(approved.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload).toMatchObject({
        kind: "ccla.approved",
        corporateId: "corp1",
        companyName: "Acme Inc",
      });
    }
  });

  it("produces a ledger chain that verifies (genesis -> ccla.approved)", async () => {
    seedPending();
    await approveCorporateCla({ corporateId: "corp1", actorUserId: "admin1" });

    const res = await verifyChain("proj1");
    expect(res.ok).toBe(true);
  });

  it("throws and appends nothing when the corporate is not PENDING", async () => {
    seedPending({ status: "ACTIVE" });

    await expect(
      approveCorporateCla({ corporateId: "corp1", actorUserId: "admin1" })
    ).rejects.toThrow(/pending/i);
    expect(h.ledger).toHaveLength(0);
  });

  it("throws when the corporate does not exist", async () => {
    await expect(
      approveCorporateCla({ corporateId: "missing", actorUserId: "admin1" })
    ).rejects.toThrow(/not found/i);
  });
});

describe("rejectCorporateCla", () => {
  it("flips PENDING to REJECTED with reason and appends a ccla.rejected event", async () => {
    seedPending();

    const res = await rejectCorporateCla({
      corporateId: "corp1",
      actorUserId: "admin1",
      reason: "Unverified entity",
    });

    expect(res.signatoryUserId).toBe("signer1");

    const row = h.corporates.get("corp1")!;
    expect(row.status).toBe("REJECTED");
    expect(row.rejectedById).toBe("admin1");
    expect(row.rejectedAt).toBeInstanceOf(Date);
    expect(row.rejectReason).toBe("Unverified entity");

    const rejected = h.ledger.find((r) => r.kind === "ccla.rejected");
    expect(rejected).toBeTruthy();
    const parsed = parseChainPayload(rejected.payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload).toMatchObject({
        kind: "ccla.rejected",
        corporateId: "corp1",
        reason: "Unverified entity",
      });
    }
  });

  it("stores a null rejectReason when the reason is empty", async () => {
    seedPending();

    await rejectCorporateCla({
      corporateId: "corp1",
      actorUserId: "admin1",
      reason: "",
    });

    expect(h.corporates.get("corp1")!.rejectReason).toBeNull();
  });

  it("throws and appends nothing when the corporate is not PENDING", async () => {
    seedPending({ status: "REJECTED" });

    await expect(
      rejectCorporateCla({
        corporateId: "corp1",
        actorUserId: "admin1",
        reason: "x",
      })
    ).rejects.toThrow(/pending/i);
    expect(h.ledger).toHaveLength(0);
  });
});

describe("ccla approval ledger payload schemas", () => {
  it("rejects a malformed ccla.approved payload (missing corporateId)", () => {
    const res = parseChainPayload(
      JSON.stringify({
        kind: "ccla.approved",
        companyName: "Acme Inc",
        approvedAt: new Date(0).toISOString(),
      })
    );
    expect(res.ok).toBe(false);
  });
});
