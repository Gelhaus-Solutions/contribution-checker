import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// GPLATLEGAL-61, D123: a project whose CLA records moved to GPlatform Legal
// reads and writes them there, through its API, in this product's row shapes.

const projectFindUnique = vi.fn();
const projectUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findUnique: (...a: unknown[]) => projectFindUnique(...a),
      update: (...a: unknown[]) => projectUpdate(...a),
    },
  },
}));

import { ClaLegalError, setLegalTransportForTests } from "@/lib/cla/legal";
import { claStore, legalStore, storeFor } from "@/lib/cla/store";
import { getClaStatus } from "@/lib/cla/status";

type Sent = { method: string; url: string; body: unknown };
let sent: Sent[] = [];
let answer: (sent: Sent) => { status: number; body: unknown };

const BASE = "https://terms.example";
const P = "cmproj000000000000000001";
const path = (rest: string) => `${BASE}/api/v1/cla/contribution-checker/projects/${P}${rest}`;

beforeEach(() => {
  sent = [];
  answer = () => ({ status: 200, body: {} });
  projectFindUnique.mockReset();
  projectUpdate.mockReset();
  setLegalTransportForTests(
    async (url, init) => {
      const one = {
        method: String(init.method),
        url,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      sent.push(one);
      const made = answer(one);
      return new Response(JSON.stringify(made.body), { status: made.status });
    },
    { baseUrl: BASE, apiKey: "gpt_prod_test" }
  );
});

afterEach(() => {
  setLegalTransportForTests(null);
});

const signatureView = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "ICLA",
  versionId: "cmver0000000000000000001",
  documentVersion: 2,
  contentHash: "a".repeat(64),
  userId: "u1",
  ghId: 42,
  ghLogin: "Octocat",
  emailSnapshot: null,
  legalName: "Octo Cat",
  affirmation: "I agree.",
  signatureKind: "typed",
  signatureText: "Octo Cat",
  signatureImageSha256: null,
  customFields: { role: "maintainer" },
  ip: "203.0.113.7",
  userAgent: "UA",
  applicationId: null,
  status: "ACTIVE",
  revokedBy: null,
  revokedAt: null,
  revokeReason: null,
  signedAt: "2026-10-18T10:00:00.000Z",
  corporateId: null,
  corporate: null,
  ...extra,
});

describe("the project's store", () => {
  it("is Legal once the project moved there, and here before", async () => {
    projectFindUnique.mockResolvedValueOnce({ claLegalEnrolledAt: null });
    expect((await claStore(P)).inLegal).toBe(false);
    projectFindUnique.mockResolvedValueOnce({ claLegalEnrolledAt: new Date() });
    expect((await claStore(P)).inLegal).toBe(true);
    expect(storeFor({ id: P, claLegalEnrolledAt: undefined }).inLegal).toBe(false);
  });

  it("signs in Legal with the version the signer was shown, and says when a newer one is current", async () => {
    answer = () => ({ status: 201, body: { id: "cmsig0000000000000000001" } });
    const store = legalStore(P);
    const signed = await store.signIcla({
      versionId: "cmver0000000000000000001",
      userId: "u1",
      ghId: 42,
      ghLogin: "Octocat",
      legalName: "Octo Cat",
      affirmation: "I agree.",
      signature: { kind: "drawn", image: "data:image/png;base64,AAAA" },
      ip: "203.0.113.7",
      userAgent: "UA",
    });
    expect(signed).toEqual({ id: "cmsig0000000000000000001" });
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: path("/signatures"),
      body: {
        versionId: "cmver0000000000000000001",
        ghLogin: "Octocat",
        signature: { kind: "drawn", text: null, image: "data:image/png;base64,AAAA" },
        applicationId: null,
      },
    });
    answer = () => ({
      status: 409,
      body: { code: "cla.version-moved", message: "A newer ICLA (v3) was published." },
    });
    await expect(
      store.signIcla({
        versionId: "cmver0000000000000000001",
        userId: "u1",
        ghId: 42,
        ghLogin: "Octocat",
        legalName: "Octo Cat",
        affirmation: "I agree.",
        ip: "203.0.113.7",
        userAgent: "UA",
      })
    ).rejects.toMatchObject({ status: 409, code: "cla.version-moved" });
  });

  it("reads signatures as rows here, and asks for images 50 at a time", async () => {
    answer = (one) => {
      const url = new URL(one.url);
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("perPage"));
      return {
        status: 200,
        body: {
          // A full page, 120 in all: the store reads on until it has what it asked for.
          items: Array.from({ length: Math.min(size, 120 - (page - 1) * size) }, (_, i) =>
            signatureView(`cmsig${String(page).padStart(3, "0")}${String(i).padStart(17, "0")}`)
          ),
          total: 120,
          page,
          pages: 3,
        },
      };
    };
    const store = legalStore(P);
    const page = await store.signatures({ q: "octo", skip: 0, take: 25 });
    expect(page.total).toBe(120);
    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toMatchObject({
      ghLogin: "Octocat",
      revokedById: null,
      customFields: '{"role":"maintainer"}',
      corporateSignatory: null,
    });
    expect(page.items[0]?.signedAt).toEqual(new Date("2026-10-18T10:00:00.000Z"));
    expect(sent[0]?.url).toBe(path("/signatures?perPage=25&page=1&q=octo"));
    sent = [];
    const shown = await store.signatures({ skip: 50, take: 100, withImages: true });
    expect(sent.map((one) => one.url)).toEqual([
      path("/signatures?perPage=50&page=2&withImages=true"),
      path("/signatures?perPage=50&page=3&withImages=true"),
    ]);
    // 120 in all: the last page is short, and the store stops there.
    expect(shown.items).toHaveLength(70);
  });

  it("answers a missing row as null, as a lookup here would", async () => {
    answer = () => ({ status: 404, body: { code: "not-found", message: "No CLA signature by that name." } });
    expect(await legalStore(P).signature("cmsig0000000000000000099")).toBeNull();
    answer = () => ({ status: 500, body: { message: "broken" } });
    await expect(legalStore(P).signature("cmsig0000000000000000099")).rejects.toBeInstanceOf(
      ClaLegalError
    );
  });

  it("publishes in Legal and keeps the project's pointers as a mirror of Legal's", async () => {
    answer = (one) =>
      one.method === "POST"
        ? { status: 201, body: { id: "cmver0000000000000000003", version: 3, contentHash: "b".repeat(64), affectedGhIds: [42] } }
        : {
            status: 200,
            body: {
              currentIclaVersionId: "cmver0000000000000000003",
              currentCclaVersionId: null,
              minIclaVersion: 3,
              minCclaVersion: 0,
            },
          };
    const published = await legalStore(P).publishVersion({
      kind: "ICLA",
      bodyMarkdown: "# ICLA",
      requireResign: true,
      resignVersionIds: ["cmver0000000000000000001"],
      actorUserId: "admin",
    });
    expect(published.affectedGhIds).toEqual([42]);
    expect(sent[0]?.body).toMatchObject({ requireResign: true, resignVersionIds: [] });
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: P },
      data: {
        currentIclaVersionId: "cmver0000000000000000003",
        currentCclaVersionId: null,
        minIclaVersion: 3,
        minCclaVersion: 0,
      },
    });
  });
});

describe("coverage of a project in Legal", () => {
  it("is Legal's answer, and its last one while Legal cannot be reached", async () => {
    projectFindUnique.mockResolvedValue({ claLegalEnrolledAt: new Date() });
    answer = () => ({ status: 200, body: { satisfied: true, via: "icla" } });
    const who = { projectId: P, ghId: 7, ghLogin: "Someone" };
    expect(await getClaStatus(who)).toEqual({ satisfied: true, via: "icla" });
    expect(sent[0]?.url).toBe(path("/status?ghId=7&ghLogin=Someone"));
    setLegalTransportForTests(
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
      { baseUrl: BASE, apiKey: "gpt_prod_test" }
    );
    expect(await getClaStatus(who)).toEqual({ satisfied: true, via: "icla" });
    await expect(getClaStatus({ ...who, ghId: 8 })).rejects.toMatchObject({ status: null });
  });
});
