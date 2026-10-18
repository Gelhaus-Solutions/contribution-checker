import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// GPLATLEGAL-61, D123: moving a project's CLA records to GPlatform Legal sends
// its history while the project stays in use, then, holding the project row,
// what was written meanwhile, compares the chain heads and switches over.

const h = vi.hoisted(() => {
  const state = {
    project: {
      id: "cmproj000000000000000001",
      slug: "postiz",
      name: "Postiz",
      claLegalEnrolledAt: null as Date | null,
      claEnabled: true,
      claRequired: true,
      claCorporateEnabled: true,
      claCorporateRequiresApproval: true,
      claPlacementEmbed: true,
      claPlacementStandalone: true,
      labelClaPending: "contribution:cla-pending",
      currentIclaVersionId: "cmver0000000000000000001",
      currentCclaVersionId: null as string | null,
    },
    versions: [] as Record<string, unknown>[],
    signatures: [] as Record<string, unknown>[],
    events: [] as { seq: number; kind: string; entryHash: string; [k: string]: unknown }[],
    locked: 0,
    /** Written "meanwhile": appended when the first import batch is sent. */
    meanwhile: null as null | (() => void),
  };
  const rows = (list: Record<string, unknown>[]) => ({
    findMany: async (args: { where: { id?: { in: string[] } } }) =>
      list.filter((r) => !args.where.id || args.where.id.in.includes(String(r.id))),
  });
  const client = {
    project: {
      findUnique: async () => state.project,
      findUniqueOrThrow: async () => state.project,
      update: async (args: { data: Record<string, unknown> }) => Object.assign(state.project, args.data),
    },
    claDocumentVersion: rows(state.versions),
    claSignature: rows(state.signatures),
    corporateCla: rows([]),
    cclaRosterMember: rows([]),
    claWaiver: rows([]),
    claEventLog: {
      findMany: async (args: { where: { seq?: { gt: number } } }) =>
        state.events.filter((e) => args.where.seq === undefined || e.seq > args.where.seq.gt),
      findFirst: async () => state.events.at(-1) ?? null,
    },
    $queryRaw: async () => {
      state.locked += 1;
      return [{ id: state.project.id }];
    },
  };
  return {
    state,
    prisma: { ...client, $transaction: async (fn: (tx: typeof client) => unknown) => fn(client) },
  };
});

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { setLegalTransportForTests } from "@/lib/cla/legal";
import { moveClaToLegal } from "@/lib/cla/move-to-legal";

const at = new Date("2026-10-01T10:00:00.000Z");
const event = (seq: number, kind: string, links: Record<string, string | null> = {}) => ({
  id: `e${seq}`,
  projectId: h.state.project.id,
  seq,
  kind,
  payload: JSON.stringify({ kind }),
  actorUserId: null,
  actorGhId: null,
  signatureId: null,
  documentVersionId: null,
  rosterMemberId: null,
  corporateId: null,
  waiverId: null,
  prevHash: seq === 0 ? "GENESIS" : `h${seq - 1}`,
  entryHash: `h${seq}`,
  createdAt: at,
  ...links,
});
const signature = (id: string, status = "ACTIVE") => ({
  id,
  projectId: h.state.project.id,
  versionId: "cmver0000000000000000001",
  kind: "ICLA",
  userId: "u1",
  ghId: 42,
  ghLogin: "octocat",
  emailSnapshot: null,
  legalName: "Octo Cat",
  affirmation: "I agree.",
  agreed: true,
  documentVersion: 1,
  contentHash: "a".repeat(64),
  signatureKind: "typed",
  signatureText: "Octo Cat",
  signatureImage: null,
  ip: "203.0.113.7",
  userAgent: "UA",
  applicationId: null,
  customFields: null,
  status,
  revokedById: status === "REVOKED" ? "admin" : null,
  revokedAt: status === "REVOKED" ? at : null,
  revokeReason: status === "REVOKED" ? "wrong account" : null,
  signedAt: at,
});

type Sent = { method: string; url: string; body: Record<string, unknown[] | unknown> | undefined };
let sent: Sent[] = [];
/** What Legal holds of the chain: the entries it was sent, by seq. */
let legalChain: Map<number, string>;

beforeEach(() => {
  sent = [];
  legalChain = new Map();
  h.state.project.claLegalEnrolledAt = null;
  h.state.locked = 0;
  h.state.meanwhile = null;
  h.state.versions.splice(0, Infinity, {
    id: "cmver0000000000000000001",
    projectId: h.state.project.id,
    kind: "ICLA",
    version: 1,
    bodyMarkdown: "# ICLA",
    contentHash: "a".repeat(64),
    sourceType: "manual",
    sourceRepoId: null,
    sourcePath: null,
    sourceRef: null,
    sourceCommitSha: null,
    requireResign: false,
    resignRequired: false,
    publishedById: "admin",
    publishedAt: at,
  });
  h.state.signatures.splice(0, Infinity, signature("cmsig0000000000000000001"));
  h.state.events.splice(
    0,
    Infinity,
    event(0, "genesis"),
    event(1, "doc.published", { documentVersionId: "cmver0000000000000000001" }),
    event(2, "icla.signed", { signatureId: "cmsig0000000000000000001" })
  );
  setLegalTransportForTests(
    async (url, init) => {
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      sent.push({ method: String(init.method), url, body });
      if (url.endsWith("/import")) {
        for (const e of (body.events ?? []) as { seq: number; entryHash: string }[]) {
          legalChain.set(e.seq, e.entryHash);
        }
        h.state.meanwhile?.();
        h.state.meanwhile = null;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (init.method === "GET") {
        const last = Math.max(-1, ...legalChain.keys());
        return new Response(
          JSON.stringify({ chain: { entries: legalChain.size, head: legalChain.get(last) ?? null } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ outcome: "enrolled" }), { status: 200 });
    },
    { baseUrl: "https://terms.example", apiKey: "gpt_prod_test" }
  );
});

afterEach(() => {
  setLegalTransportForTests(null);
});

const imports = () => sent.filter((one) => one.url.endsWith("/import")).map((one) => one.body ?? {});

describe("moving a project's CLA records to Legal", () => {
  it("only counts without --execute", async () => {
    const report = await moveClaToLegal(h.state.project.id, { dryRun: true });
    expect(report).toMatchObject({
      outcome: "dry-run",
      sent: { versions: 1, signatures: 1, events: 3 },
      head: "h2",
    });
    expect(sent).toEqual([]);
    expect(h.state.project.claLegalEnrolledAt).toBeNull();
  });

  it("enrols, sends each kind after what it rests on, and switches once the heads agree", async () => {
    const report = await moveClaToLegal(h.state.project.id);
    expect(report).toMatchObject({ outcome: "moved", head: "h2", sent: { events: 3 } });
    expect(sent[0]).toMatchObject({ method: "PUT", body: { slug: "postiz", enabled: true } });
    const kinds = imports().map((one) => Object.keys(one).join(","));
    expect(kinds).toEqual([
      "versions",
      "signatures",
      "events",
      "currentIclaVersionId,currentCclaVersionId",
    ]);
    expect(imports()[1]).toMatchObject({
      signatures: [{ id: "cmsig0000000000000000001", revokedBy: null, signedAt: at.toISOString() }],
    });
    expect(h.state.locked).toBe(1);
    expect(h.state.project.claLegalEnrolledAt).toBeInstanceOf(Date);
    expect(await moveClaToLegal(h.state.project.id)).toMatchObject({ outcome: "already" });
  });

  it("sends, holding the project, what was written while the history went", async () => {
    h.state.meanwhile = () => {
      // A revocation lands while the first batch is on its way.
      h.state.signatures[0] = signature("cmsig0000000000000000001", "REVOKED");
      h.state.events.push(event(3, "signature.revoked", { signatureId: "cmsig0000000000000000001" }));
    };
    const report = await moveClaToLegal(h.state.project.id);
    expect(report).toMatchObject({ outcome: "moved", head: "h3", sent: { events: 4, signatures: 2 } });
    const delta = imports().filter((one) => {
      const events = (one.events ?? []) as { seq: number }[];
      return events.some((e) => e.seq === 3) || (one.signatures as { status: string }[] | undefined)?.some((s) => s.status === "REVOKED");
    });
    expect(delta).toHaveLength(2);
    expect(legalChain.get(3)).toBe("h3");
  });

  it("switches nothing when Legal's chain does not end where this one does", async () => {
    h.state.meanwhile = () => {
      legalChain.set(7, "elsewhere");
    };
    await expect(moveClaToLegal(h.state.project.id)).rejects.toThrow(/nothing was switched/u);
    expect(h.state.project.claLegalEnrolledAt).toBeNull();
  });
});
