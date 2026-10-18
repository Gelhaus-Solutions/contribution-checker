import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// D126: a moved project's chain in GPlatform Legal is followed, and what
// Legal's staff wrote there (D125) has the project's pull requests checked
// again; what this instance wrote itself it checked again when it wrote it.

const projectFindMany = vi.fn();
const projectUpdate = vi.fn();
const reGateAuthorPrs = vi.fn();
const reGateProjectPrs = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findMany: (...a: unknown[]) => projectFindMany(...a),
      update: (...a: unknown[]) => projectUpdate(...a),
    },
  },
}));

vi.mock("@/lib/temporal/start", () => ({
  reGateAuthorPrs: (...a: unknown[]) => reGateAuthorPrs(...a),
  reGateProjectPrs: (...a: unknown[]) => reGateProjectPrs(...a),
}));

import {
  setLegalTransportForTests,
  type LegalEventView,
} from "@/lib/cla/legal";
import { followClaLegalChains, stepFor } from "@/lib/cla/follow";

const BASE = "https://terms.example";
const P = "cmproj000000000000000001";
const Q = "cmproj000000000000000002";
const STAFF = "staff:cmstaff00000000000000001";

const entry = (
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
  actorUserId: string | null = STAFF,
): LegalEventView => ({
  seq,
  kind,
  payload: JSON.stringify(payload),
  actorUserId,
  actorGhId: null,
  signatureId: null,
  documentVersionId: null,
  rosterMemberId: null,
  corporateId: null,
  waiverId: null,
  prevHash: "a".repeat(64),
  entryHash: "b".repeat(64),
  createdAt: "2026-10-18T18:00:00.000Z",
  imported: false,
});

/** Each project's chain as Legal holds it, oldest first. */
let chains: Record<string, LegalEventView[]>;
let down: Set<string>;
let asked: string[];

beforeEach(() => {
  chains = {};
  down = new Set();
  asked = [];
  projectFindMany.mockReset();
  projectUpdate.mockReset();
  reGateAuthorPrs.mockReset();
  reGateProjectPrs.mockReset();
  setLegalTransportForTests(
    async (url) => {
      asked.push(url);
      const [, project, rest] =
        /\/projects\/([^/?]+)(?:\/(.*))?$/u.exec(url.replace(BASE, "")) ?? [];
      if (project === undefined || down.has(project)) {
        return new Response("{}", { status: 503 });
      }
      const chain = chains[project] ?? [];
      if (rest === undefined) {
        return new Response(
          JSON.stringify({ project, chain: { entries: chain.length } }),
        );
      }
      const page = Number(/page=(\d+)/u.exec(rest)?.[1] ?? "1");
      const newestFirst = [...chain].reverse();
      const items = newestFirst.slice((page - 1) * 200, page * 200);
      return new Response(
        JSON.stringify({
          items,
          total: chain.length,
          page,
          pages: Math.max(1, Math.ceil(chain.length / 200)),
        }),
      );
    },
    { baseUrl: BASE, apiKey: "gpt_prod_test" },
  );
});

afterEach(() => {
  setLegalTransportForTests(null);
});

/** A chain of `length` entries this instance wrote, then `staff` after them. */
const chainOf = (length: number, staff: LegalEventView[] = []) => [
  ...Array.from({ length }, (_, seq) =>
    entry(
      seq,
      seq === 0 ? "genesis" : "icla.signed",
      {},
      seq === 0 ? null : "cmuser0001",
    ),
  ),
  ...staff,
];

describe("stepFor", () => {
  it("leaves what this instance wrote, and a rejected company", () => {
    expect(
      stepFor(entry(3, "signature.revoked", { ghId: 501 }, "cmuser0001")),
    ).toBeNull();
    expect(stepFor(entry(3, "waiver.granted", { ghId: 501 }, null))).toBeNull();
    expect(stepFor(entry(3, "ccla.rejected", { corporateId: "x" }))).toBeNull();
  });

  it("checks one author again where the entry names their GitHub id", () => {
    expect(
      stepFor(entry(3, "signature.revoked", { ghId: 501, ghLogin: "Octocat" })),
    ).toEqual({
      kind: "author",
      ghId: 501,
      ghLogin: "Octocat",
    });
    expect(
      stepFor(entry(3, "waiver.revoked", { ghId: 9, ghLogin: "bot" })),
    ).toEqual({
      kind: "author",
      ghId: 9,
      ghLogin: "bot",
    });
  });

  it("checks the whole project for a company, a version, or a waiver by login only", () => {
    expect(stepFor(entry(3, "ccla.approved", { corporateId: "x" }))).toEqual({
      kind: "all",
    });
    expect(stepFor(entry(3, "ccla.revoked", { corporateId: "x" }))).toEqual({
      kind: "all",
    });
    expect(stepFor(entry(3, "doc.resign_set", { versions: [] }))).toEqual({
      kind: "all",
    });
    expect(
      stepFor(entry(3, "waiver.granted", { ghId: null, ghLogin: "x" })),
    ).toEqual({
      kind: "all",
    });
  });
});

describe("followClaLegalChains", () => {
  it("starts a project at its chain's head, checking nothing again", async () => {
    chains[P] = chainOf(8);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: null }]);
    await expect(followClaLegalChains()).resolves.toEqual({
      projects: 1,
      entries: 0,
      regated: 0,
    });
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: P },
      data: { claLegalFollowedSeq: 7 },
    });
    expect(asked.some((url) => url.includes("/events"))).toBe(false);
    expect(reGateProjectPrs).not.toHaveBeenCalled();
  });

  it("reads nothing past the head when nothing was written", async () => {
    chains[P] = chainOf(8);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: 7 }]);
    await followClaLegalChains();
    expect(asked).toHaveLength(1);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("checks each named author again once, and notes the newest entry", async () => {
    chains[P] = chainOf(8, [
      entry(8, "signature.revoked", { ghId: 501, ghLogin: "Octocat" }),
      entry(9, "icla.signed", { ghId: 777 }, "cmuser0001"),
      entry(10, "waiver.granted", { ghId: 501, ghLogin: "octocat" }),
      entry(11, "waiver.revoked", { ghId: 42, ghLogin: "lena-k" }),
    ]);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: 7 }]);
    await expect(followClaLegalChains()).resolves.toEqual({
      projects: 1,
      entries: 4,
      regated: 2,
    });
    expect(reGateAuthorPrs.mock.calls.map(([one]) => one)).toEqual([
      {
        projectId: P,
        ghId: 501,
        ghLogin: "octocat",
        reason: "cla_legal_staff",
      },
      { projectId: P, ghId: 42, ghLogin: "lena-k", reason: "cla_legal_staff" },
    ]);
    expect(reGateProjectPrs).not.toHaveBeenCalled();
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: P },
      data: { claLegalFollowedSeq: 11 },
    });
  });

  it("checks the whole project once when a company's step is among them", async () => {
    chains[P] = chainOf(8, [
      entry(8, "signature.revoked", { ghId: 501 }),
      entry(9, "ccla.approved", { corporateId: "x" }),
    ]);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: 7 }]);
    await followClaLegalChains();
    expect(reGateProjectPrs).toHaveBeenCalledTimes(1);
    expect(reGateProjectPrs).toHaveBeenCalledWith({
      projectId: P,
      reason: "cla_legal_staff",
    });
    expect(reGateAuthorPrs).not.toHaveBeenCalled();
  });

  it("notes what this instance wrote as followed, checking nothing again", async () => {
    chains[P] = chainOf(10);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: 7 }]);
    await followClaLegalChains();
    expect(reGateAuthorPrs).not.toHaveBeenCalled();
    expect(reGateProjectPrs).not.toHaveBeenCalled();
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: P },
      data: { claLegalFollowedSeq: 9 },
    });
  });

  it("reads past one page of entries", async () => {
    chains[P] = chainOf(5, [
      entry(5, "signature.revoked", { ghId: 501 }),
      ...Array.from({ length: 300 }, (_, i) =>
        entry(6 + i, "icla.signed", {}, "cmuser0001"),
      ),
    ]);
    projectFindMany.mockResolvedValue([{ id: P, claLegalFollowedSeq: 4 }]);
    await expect(followClaLegalChains()).resolves.toMatchObject({
      entries: 301,
      regated: 1,
    });
    expect(reGateAuthorPrs).toHaveBeenCalledTimes(1);
  });

  it("leaves a project whose chain cannot be read where it was, and follows the rest", async () => {
    down.add(P);
    chains[Q] = chainOf(3, [entry(3, "signature.revoked", { ghId: 501 })]);
    projectFindMany.mockResolvedValue([
      { id: P, claLegalFollowedSeq: 7 },
      { id: Q, claLegalFollowedSeq: 2 },
    ]);
    await expect(followClaLegalChains()).resolves.toEqual({
      projects: 2,
      entries: 1,
      regated: 1,
    });
    expect(projectUpdate).toHaveBeenCalledTimes(1);
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: Q },
      data: { claLegalFollowedSeq: 3 },
    });
  });

  it("does nothing where Legal is not configured", async () => {
    setLegalTransportForTests(async () => new Response("{}"), null);
    await expect(followClaLegalChains()).resolves.toBeNull();
    expect(projectFindMany).not.toHaveBeenCalled();
  });
});
