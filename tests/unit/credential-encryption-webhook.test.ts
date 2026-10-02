import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ProjectWebhook.secret rests encrypted (Vault Transit): written encrypted by
// the settings actions, decrypted only where a delivery is signed.

const encrypt = vi.fn();
const decryptBatch = vi.fn();
vi.mock("@/lib/vault/resolver", () => ({
  getVaultClient: () => ({
    transitEncrypt: (...a: unknown[]) => encrypt(...a),
    transitDecryptBatch: (...a: unknown[]) => decryptBatch(...a),
  }),
}));

const create = vi.fn();
const update = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    projectWebhook: {
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
  },
}));
vi.mock("@/lib/authz", () => ({
  requireProjectRole: vi.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/http/safe-url", () => ({
  assertSafeOutboundUrl: vi.fn(async () => undefined),
  UnsafeOutboundUrlError: class extends Error {},
}));
vi.mock("@/lib/notifications/webhooks", () => ({ enqueueProjectWebhook: vi.fn() }));
vi.mock("@/lib/temporal/start", () => ({ reGateProjectPrs: vi.fn() }));
vi.mock("@/lib/labels", () => ({ assertLabelsUnique: vi.fn() }));

import {
  addProjectWebhook,
  updateProjectWebhook,
} from "@/app/dashboard/projects/[id]/settings/actions";
import { deliverOutboundAttempt } from "@/worker/activities/webhook-delivery";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  for (const m of [encrypt, decryptBatch, create, update, findUnique]) m.mockReset();
  vi.stubEnv("VAULT_ADDR", "https://vault.example.com");
  encrypt.mockImplementation(async (p: string) => `vault:v1:${b64(p)}`);
  decryptBatch.mockImplementation(async (cts: string[]) =>
    cts.map((c) => Buffer.from(c.replace(/^vault:v\d+:/, ""), "base64").toString("utf8")),
  );
});

describe("saving a webhook endpoint", () => {
  it("stores the secret encrypted on create", async () => {
    await addProjectWebhook(
      form({ projectId: "p1", kind: "generic", url: "https://hooks.example/x", secret: "hunter2-hunter2" }),
    );
    const { data } = create.mock.calls[0]![0];
    expect(data.secret).toBe(`vault:v1:${b64("hunter2-hunter2")}`);
    expect(JSON.stringify(data)).not.toContain("hunter2-hunter2");
  });

  it("stores the secret encrypted on update", async () => {
    findUnique.mockResolvedValue({ projectId: "p1" });
    await updateProjectWebhook(
      form({
        projectId: "p1", endpointId: "e1", kind: "generic",
        url: "https://hooks.example/x", secret: "rotated-secret-1", enabled: "on",
      }),
    );
    const { data } = update.mock.calls[0]![0];
    expect(data.secret).toMatch(/^vault:v1:/);
    expect(JSON.stringify(data)).not.toContain("rotated-secret-1");
  });

  it("keeps a cleared secret null and a Discord endpoint secret-free", async () => {
    await addProjectWebhook(form({ projectId: "p1", kind: "generic", url: "https://h.example/x", secret: "" }));
    expect(create.mock.calls[0]![0].data.secret).toBeNull();
    await addProjectWebhook(
      form({ projectId: "p1", kind: "discord", url: "https://h.example/y", secret: "ignored-secret-1" }),
    );
    expect(create.mock.calls[1]![0].data.secret).toBeNull();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("saves nothing when Vault cannot encrypt", async () => {
    encrypt.mockRejectedValue(new Error("vault down"));
    await expect(
      addProjectWebhook(
        form({ projectId: "p1", kind: "generic", url: "https://h.example/x", secret: "hunter2-hunter2" }),
      ),
    ).rejects.toThrow(/nothing was saved/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("delivering to an endpoint", () => {
  const input = {
    projectId: "p1", endpointId: "e1", kind: "generic" as const,
    event: "pr.opened", body: '{"a":1}', url: "https://hooks.example/x",
  };
  const sigFor = (secret: string) =>
    "sha256=" + createHmac("sha256", secret).update(input.body).digest("hex");

  it("signs with the decrypted secret", async () => {
    findUnique.mockResolvedValue({ secret: `vault:v1:${b64("hunter2-hunter2")}` });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await deliverOutboundAttempt(input);

    expect(res.ok).toBe(true);
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["X-ContribCheck-Signature"]).toBe(sigFor("hunter2-hunter2"));
    vi.unstubAllGlobals();
  });

  it("still signs a legacy plaintext secret", async () => {
    findUnique.mockResolvedValue({ secret: "legacy-plain-secret" });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverOutboundAttempt(input);

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["X-ContribCheck-Signature"]).toBe(sigFor("legacy-plain-secret"));
    expect(decryptBatch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not post unsigned when the secret cannot be decrypted", async () => {
    findUnique.mockResolvedValue({ secret: `vault:v1:${b64("hunter2-hunter2")}` });
    decryptBatch.mockRejectedValue(new Error("vault down"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverOutboundAttempt(input)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
