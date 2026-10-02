import { beforeEach, describe, expect, it, vi } from "vitest";

// Credentials on QaBoardLink rest encrypted (Vault Transit). These tests pin the
// three places that touch them: the write (link action), the use inside the
// sync, and the callback route that verifies a signature with them.

const encrypt = vi.fn();
const decryptBatch = vi.fn();
vi.mock("@/lib/vault/resolver", () => ({
  getVaultClient: () => ({
    transitEncrypt: (...a: unknown[]) => encrypt(...a),
    transitDecryptBatch: (...a: unknown[]) => decryptBatch(...a),
  }),
}));

const upsert = vi.fn();
const linkUpdate = vi.fn();
const linkFindMany = vi.fn();
const linkFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    repo: {
      findUnique: vi.fn(async () => ({
        id: "repo1",
        fullName: "acme/app",
        projectId: "proj1",
      })),
    },
    qaBoardLink: {
      upsert: (...a: unknown[]) => upsert(...a),
      update: (...a: unknown[]) => linkUpdate(...a),
      findMany: (...a: unknown[]) => linkFindMany(...a),
      findFirst: (...a: unknown[]) => linkFindFirst(...a),
      delete: vi.fn(),
    },
    stagingBatch: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    stagingBatchItem: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    processedWebhookDelivery: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
  },
}));

const verify = vi.fn();
const registerHook = vi.fn();
const unregisterHook = vi.fn();
const pullChanges = vi.fn();
vi.mock("@/lib/qa/board/notion", () => ({
  notionAdapter: {
    provider: "notion",
    verify: (...a: unknown[]) => verify(...a),
    registerHook: (...a: unknown[]) => registerHook(...a),
    unregisterHook: (...a: unknown[]) => unregisterHook(...a),
    pullChanges: (...a: unknown[]) => pullChanges(...a),
    createCard: async () => ({ externalId: "p", externalUrl: "u" }),
    updateCard: async () => undefined,
    archiveCard: async () => undefined,
  },
}));
vi.mock("@/lib/qa/board/trello", () => ({ trelloAdapter: { provider: "trello" } }));

vi.mock("@/lib/authz", () => ({
  requireProjectRole: vi.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/notifications/inbox", () => ({ notifyProjectReviewers: vi.fn() }));
vi.mock("@/lib/ai/tasks/qa-steps", () => ({ qaStepsTask: {} }));
vi.mock("@/lib/ai/tasks/release-narrative", () => ({ releaseNarrativeTask: {} }));
vi.mock("@/lib/ai/prompt", () => ({ subjectKeys: vi.fn() }));
const signal = vi.fn();
vi.mock("@/lib/temporal/start", () => ({
  runAiTaskWorkflow: vi.fn(),
  runQaTaskToggle: vi.fn(),
  signalQaBoardSync: (...a: unknown[]) => signal(...a),
  signalStagingBatch: vi.fn(),
}));

import { linkQaBoard, unlinkQaBoard } from "@/app/dashboard/projects/[id]/qa/actions";
import { syncQaBoards } from "@/lib/qa/board/sync";
import { POST } from "@/app/api/qa/[provider]/route";
import { createHmac } from "node:crypto";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeEach(() => {
  for (const m of [
    encrypt, decryptBatch, upsert, linkUpdate, linkFindMany, linkFindFirst,
    verify, registerHook, unregisterHook, pullChanges, signal,
  ]) {
    m.mockReset();
  }
  vi.stubEnv("VAULT_ADDR", "https://vault.example.com");
  verify.mockResolvedValue({ ok: true });
  registerHook.mockResolvedValue(null);
  unregisterHook.mockResolvedValue(undefined);
  pullChanges.mockResolvedValue([]);
  linkUpdate.mockResolvedValue({});
  upsert.mockResolvedValue({ id: "link1" });
  // A fake Transit: wrap on encrypt, unwrap on decrypt.
  encrypt.mockImplementation(async (p: string) => `vault:v1:${Buffer.from(p).toString("base64")}`);
  decryptBatch.mockImplementation(async (cts: string[]) =>
    cts.map((c) => Buffer.from(c.replace(/^vault:v\d+:/, ""), "base64").toString("utf8")),
  );
});

describe("linking a board", () => {
  it("stores the token and key encrypted, and verifies against the plaintext", async () => {
    const res = await linkQaBoard({
      projectId: "proj1",
      repoId: "repo1",
      provider: "notion",
      targetId: "db1",
      token: "  ntn_plain  ",
      apiKey: "key_plain",
    });

    expect(res).toEqual({ ok: true });
    // The provider is asked with the real credential...
    expect(verify.mock.calls[0]![0]).toMatchObject({ token: "ntn_plain", apiKey: "key_plain" });
    expect(registerHook.mock.calls[0]![0]).toMatchObject({ token: "ntn_plain" });
    // ...and the row never holds it.
    const { create, update } = upsert.mock.calls[0]![0];
    for (const data of [create, update]) {
      expect(data.token).toMatch(/^vault:v1:/);
      expect(data.apiKey).toMatch(/^vault:v1:/);
      expect(JSON.stringify(data)).not.toContain("ntn_plain");
      expect(JSON.stringify(data)).not.toContain("key_plain");
    }
  });

  it("saves nothing when Vault cannot encrypt", async () => {
    encrypt.mockRejectedValue(new Error("vault down"));
    await expect(
      linkQaBoard({
        projectId: "proj1", repoId: "repo1", provider: "notion", targetId: "db1", token: "ntn_plain",
      }),
    ).rejects.toThrow(/nothing was saved/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("decrypts before telling the provider to drop the hook on unlink", async () => {
    linkFindFirst.mockResolvedValue({
      id: "link1", repoId: "repo1", provider: "notion", targetId: "db1", hookId: "h1",
      token: "vault:v1:" + b64("ntn_plain"), apiKey: null, statusMap: "{}",
    });
    await unlinkQaBoard({ projectId: "proj1", linkId: "link1" });
    expect(unregisterHook.mock.calls[0]![0]).toMatchObject({ token: "ntn_plain", apiKey: null });
  });
});

describe("the sync", () => {
  it("hands the adapter the decrypted token, and a legacy plaintext row still works", async () => {
    linkFindMany.mockResolvedValue([
      { id: "a", repoId: "repo1", provider: "notion", targetId: "db1", statusMap: "{}", lastPulledAt: null,
        token: "vault:v1:" + b64("ntn_encrypted"), apiKey: null },
    ]);
    const { prisma } = await import("@/lib/db");
    (prisma.stagingBatch.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "batch1" });

    await syncQaBoards({ repoId: "repo1" });
    expect(pullChanges.mock.calls[0]![0]).toMatchObject({ token: "ntn_encrypted" });

    pullChanges.mockClear();
    linkFindMany.mockResolvedValue([
      { id: "b", repoId: "repo1", provider: "notion", targetId: "db1", statusMap: "{}", lastPulledAt: null,
        token: "ntn_legacy", apiKey: null },
    ]);
    await syncQaBoards({ repoId: "repo1" });
    expect(pullChanges.mock.calls[0]![0]).toMatchObject({ token: "ntn_legacy" });
  });

  it("records a failed decrypt on the link instead of crashing the run, without the value", async () => {
    linkFindMany.mockResolvedValue([
      { id: "a", repoId: "repo1", provider: "notion", targetId: "db1", statusMap: "{}", lastPulledAt: null,
        token: "vault:v1:" + b64("ntn_encrypted"), apiKey: null },
    ]);
    decryptBatch.mockRejectedValue(new Error("vault down"));
    const result = await syncQaBoards({ repoId: "repo1" });
    expect(result.failed).toBe(1);
    expect(pullChanges).not.toHaveBeenCalled();
    expect(JSON.stringify(linkUpdate.mock.calls)).not.toContain("ntn_encrypted");
  });
});

describe("the board callback route", () => {
  const post = (body: string, sig: string | null) =>
    POST(
      new Request("https://app.example/api/qa/notion", {
        method: "POST",
        headers: sig ? { "x-notion-signature": sig } : {},
        body,
      }),
      { params: Promise.resolve({ provider: "notion" }) },
    );
  const sign = (secret: string, body: string) =>
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("verifies the signature against the decrypted token", async () => {
    linkFindMany.mockResolvedValue([
      { id: "a", repoId: "repo1", token: "vault:v1:" + b64("ntn_secret"), apiKey: null },
      { id: "b", repoId: "repo2", token: "vault:v1:" + b64("someone_else"), apiKey: null },
    ]);
    const body = JSON.stringify({ type: "page.updated" });

    const ok = await post(body, sign("ntn_secret", body));
    expect(ok.status).toBe(200);
    expect(signal).toHaveBeenCalledTimes(1);
    // Both candidates were decrypted in a single Vault request.
    expect(decryptBatch).toHaveBeenCalledTimes(1);

    const bad = await post(body, sign("wrong", body));
    expect(bad.status).toBe(401);
  });

  it("answers 503, not 401, when Vault cannot decrypt, so the provider retries", async () => {
    linkFindMany.mockResolvedValue([
      { id: "a", repoId: "repo1", token: "vault:v1:" + b64("ntn_secret"), apiKey: null },
    ]);
    decryptBatch.mockRejectedValue(new Error("vault down"));
    const body = JSON.stringify({ type: "page.updated" });
    const res = await post(body, sign("ntn_secret", body));
    expect(res.status).toBe(503);
    expect(signal).not.toHaveBeenCalled();
  });
});
