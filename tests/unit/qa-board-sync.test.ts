import { beforeEach, describe, expect, it, vi } from "vitest";

const repoFindUnique = vi.fn();
const linkFindMany = vi.fn();
const linkUpdate = vi.fn();
const batchFindFirst = vi.fn();
const batchFindMany = vi.fn();
const itemFindMany = vi.fn();
const itemUpdate = vi.fn();
const auditCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    repo: { findUnique: (...a: unknown[]) => repoFindUnique(...a) },
    qaBoardLink: {
      findMany: (...a: unknown[]) => linkFindMany(...a),
      update: (...a: unknown[]) => linkUpdate(...a),
    },
    stagingBatch: {
      findFirst: (...a: unknown[]) => batchFindFirst(...a),
      findMany: (...a: unknown[]) => batchFindMany(...a),
    },
    stagingBatchItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      update: (...a: unknown[]) => itemUpdate(...a),
    },
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}));

const createCard = vi.fn();
const updateCard = vi.fn();
const archiveCard = vi.fn();
const pullChanges = vi.fn();

vi.mock("@/lib/qa/board/notion", () => ({
  notionAdapter: {
    provider: "notion",
    createCard: (...a: unknown[]) => createCard(...a),
    updateCard: (...a: unknown[]) => updateCard(...a),
    archiveCard: (...a: unknown[]) => archiveCard(...a),
    pullChanges: (...a: unknown[]) => pullChanges(...a),
    registerHook: async () => null,
    unregisterHook: async () => undefined,
    verify: async () => ({ ok: true }),
  },
}));
vi.mock("@/lib/qa/board/trello", () => ({ trelloAdapter: { provider: "trello" } }));

import { syncQaBoards } from "@/lib/qa/board/sync";
import { hashPayload } from "@/lib/qa/board/types";

const LINK = {
  id: "link1",
  repoId: "repo1",
  provider: "notion",
  targetId: "db1",
  token: "secret",
  apiKey: null,
  statusMap: "{}",
  lastPulledAt: null as Date | null,
};

/** The payload the sync would build for the standard fixture item. */
function payloadFor(status: string, notes: string | null = null) {
  return {
    title: "#101 Add retries",
    status,
    url: "https://github.com/acme/app/pull/101",
    summary: null,
    qaSteps: null,
    notes,
  } as Parameters<typeof hashPayload>[0];
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "item1",
    prNumber: 101,
    title: "Add retries",
    summary: null,
    qaSteps: null,
    qaStatus: "QA_PENDING",
    qaNotes: null,
    droppedAt: null,
    externalProvider: null as string | null,
    externalId: null as string | null,
    externalHash: null as string | null,
    updatedAt: new Date("2026-08-01T10:00:00Z"),
    key: "pr:101",
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of [
    repoFindUnique,
    linkFindMany,
    linkUpdate,
    batchFindFirst,
    batchFindMany,
    itemFindMany,
    itemUpdate,
    auditCreate,
    createCard,
    updateCard,
    archiveCard,
    pullChanges,
  ]) {
    m.mockReset();
  }
  repoFindUnique.mockResolvedValue({
    id: "repo1",
    fullName: "acme/app",
    projectId: "proj1",
  });
  linkFindMany.mockResolvedValue([{ ...LINK }]);
  batchFindFirst.mockResolvedValue({ id: "batch1" });
  batchFindMany.mockResolvedValue([]);
  itemFindMany.mockResolvedValue([]);
  itemUpdate.mockResolvedValue({});
  linkUpdate.mockResolvedValue({});
  auditCreate.mockResolvedValue({});
  pullChanges.mockResolvedValue([]);
  createCard.mockResolvedValue({
    externalId: "page1",
    externalUrl: "https://notion.so/page1",
  });
  updateCard.mockResolvedValue(undefined);
});

describe("push", () => {
  it("creates a card for an item that has none", async () => {
    itemFindMany.mockResolvedValue([item()]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.pushed).toBe(1);
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({
      externalProvider: "notion",
      externalId: "page1",
      externalUrl: "https://notion.so/page1",
    });
  });

  it("does not rewrite a card whose content has not moved", async () => {
    // This is the loop guard: our own write must not read back as work to do.
    itemFindMany.mockResolvedValue([
      item({
        externalProvider: "notion",
        externalId: "page1",
        externalHash: hashPayload(payloadFor("QA_PENDING")),
      }),
    ]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.pushed).toBe(0);
    expect(updateCard).not.toHaveBeenCalled();
    expect(createCard).not.toHaveBeenCalled();
  });

  it("updates a card when the local verdict moved", async () => {
    itemFindMany.mockResolvedValue([
      item({
        qaStatus: "QA_PASSED",
        externalProvider: "notion",
        externalId: "page1",
        externalHash: hashPayload(payloadFor("QA_PENDING")),
      }),
    ]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.pushed).toBe(1);
    expect(updateCard).toHaveBeenCalledTimes(1);
  });

  it("skips items that dropped out of the batch", async () => {
    itemFindMany.mockResolvedValue([]);
    const result = await syncQaBoards({ repoId: "repo1" });
    expect(result.pushed).toBe(0);
  });
});

describe("pull", () => {
  const fresher = new Date("2026-08-02T10:00:00Z");
  const staler = new Date("2026-07-01T10:00:00Z");

  function linkedItem(overrides: Record<string, unknown> = {}) {
    return item({
      externalProvider: "notion",
      externalId: "page1",
      externalHash: hashPayload(payloadFor("QA_PENDING")),
      ...overrides,
    });
  }

  it("applies a newer external verdict", async () => {
    pullChanges.mockResolvedValue([
      {
        externalId: "page1",
        status: "QA_PASSED",
        actor: "Dana",
        editedAt: fresher,
      },
    ]);
    itemFindMany.mockResolvedValue([linkedItem()]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.applied).toBe(1);
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({
      qaStatus: "QA_PASSED",
      qaByExternal: "Dana",
      qaById: null,
    });
  });

  it("settles the hash so the pull does not cause a push straight back", async () => {
    // Without this the bot rewrites the card with the value it just read, which
    // every provider records as another edit.
    pullChanges.mockResolvedValue([
      { externalId: "page1", status: "QA_PASSED", actor: "Dana", editedAt: fresher },
    ]);
    itemFindMany.mockResolvedValue([linkedItem()]);

    await syncQaBoards({ repoId: "repo1" });

    expect(itemUpdate.mock.calls[0][0].data.externalHash).toBe(
      hashPayload(payloadFor("QA_PASSED")),
    );
  });

  it("ignores an external edit older than the local verdict", async () => {
    pullChanges.mockResolvedValue([
      { externalId: "page1", status: "QA_FAILED", actor: "Dana", editedAt: staler },
    ]);
    itemFindMany.mockResolvedValue([linkedItem({ qaStatus: "QA_PASSED" })]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.applied).toBe(0);
  });

  it("ignores an echo of the status we already hold", async () => {
    pullChanges.mockResolvedValue([
      { externalId: "page1", status: "QA_PENDING", actor: "Dana", editedAt: fresher },
    ]);
    itemFindMany.mockResolvedValue([linkedItem()]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.applied).toBe(0);
  });

  it("ignores a card whose status does not decode", async () => {
    // Somebody renamed a Notion option or dragged a card somewhere unmapped.
    pullChanges.mockResolvedValue([
      { externalId: "page1", status: null, actor: "Dana", editedAt: fresher },
    ]);
    itemFindMany.mockResolvedValue([linkedItem()]);

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.applied).toBe(0);
  });

  it("audits an applied external change as a system event", async () => {
    pullChanges.mockResolvedValue([
      { externalId: "page1", status: "QA_PASSED", actor: "Dana", editedAt: fresher },
    ]);
    itemFindMany.mockResolvedValue([linkedItem()]);

    await syncQaBoards({ repoId: "repo1" });

    const call = auditCreate.mock.calls[0][0].data;
    expect(call.kind).toBe("qa.item_status_changed");
    // No local user made this call, so it must not be attributed to one.
    expect(call.actorId).toBeNull();
    expect(JSON.parse(call.payload)).toMatchObject({
      source: "notion",
      actor: "Dana",
    });
  });
});

describe("failures", () => {
  it("records the error on the link instead of throwing", async () => {
    pullChanges.mockRejectedValue(new Error("Notion says the token is invalid"));

    const result = await syncQaBoards({ repoId: "repo1" });

    expect(result.failed).toBe(1);
    const update = linkUpdate.mock.calls.find(
      (c) => c[0].data.lastError !== undefined,
    );
    expect(update?.[0].data.lastError).toContain("token is invalid");
  });

  it("does nothing when the repo has no links", async () => {
    linkFindMany.mockResolvedValue([]);
    const result = await syncQaBoards({ repoId: "repo1" });
    expect(result).toEqual({ applied: 0, pushed: 0, failed: 0 });
    expect(pullChanges).not.toHaveBeenCalled();
  });
});
