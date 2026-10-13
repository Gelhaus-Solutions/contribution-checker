import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK's network calls are replaced; its stage reader, honeytokens and
// helpers stay real, so these tests exercise the SDK as the app uses it.
const sdk = vi.hoisted(() => ({
  signal: vi.fn(),
  escalate: vi.fn(),
  reportDecoys: vi.fn(),
  askStage: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock("@ghub/glockdown-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghub/glockdown-sdk")>()),
  ...sdk,
}));
vi.mock("@/lib/audit", () => audit);

const dir = mkdtempSync(join(tmpdir(), "cc-lockdown-"));
const identity = join(dir, "identity");
mkdirSync(identity);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stageFile(
  rung: string,
  stage = rung === "aal" || rung === "aal2" ? "full" : rung,
) {
  const tmp = join(dir, "contribution-checker.json.tmp");
  writeFileSync(
    tmp,
    JSON.stringify({
      v: 1,
      app: "contribution-checker",
      rung,
      stage,
      at: 1_791_700_000,
    }),
  );
  renameSync(tmp, join(dir, "contribution-checker.json"));
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const DECOY_KEY = "cc_live_7f3a9e0d1b2c4a5f";
const PIN = "A".repeat(43);

async function load(
  floor?: string,
  extra: { edge?: boolean; logins?: string; keys?: string } = {},
) {
  vi.resetModules();
  vi.stubEnv("GLOCKDOWN_STAGE_DIR", dir);
  vi.stubEnv("CC_LOCKDOWN", floor ?? "off");
  // Port 9 refuses: the stage reader's own background ask (which the mock
  // does not reach) fails at once and changes nothing.
  vi.stubEnv("GLOCKDOWN_EDGE_URL", extra.edge ? "https://127.0.0.1:9" : "");
  vi.stubEnv("GLOCKDOWN_EDGE_PINS", extra.edge ? PIN : "");
  vi.stubEnv("GLOCKDOWN_IDENTITY_DIR", identity);
  vi.stubEnv("GLOCKDOWN_DECOY_LOGIN", extra.logins ?? "");
  vi.stubEnv("GLOCKDOWN_DECOY_KEY_SHA256", extra.keys ?? "");
  return import("@/lib/lockdown");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("GLockdown's kill switch", () => {
  beforeEach(() => {
    rmSync(join(dir, "contribution-checker.json"), { force: true });
    vi.unstubAllEnvs();
  });

  it("is off while the agent has written nothing, and follows the file", async () => {
    const l = await load();
    expect(l.lockdown()).toEqual({ stage: "off", rung: null, refusesEveryCredential: false });
    stageFile("members");
    l.resetLockdownForTests();
    expect(l.lockdown()).toEqual({
      stage: "members",
      rung: "members",
      refusesEveryCredential: false,
    });
  });

  it("takes the stricter of the file and CC_LOCKDOWN, which nothing lowers", async () => {
    stageFile("signups");
    const l = await load("admins");
    expect(l.lockdown().stage).toBe("admins");
  });

  it("refuses everyone at AAL phase 1, and stops the bot only from phase 2", async () => {
    stageFile("aal");
    const l = await load();
    expect(l.lockdown()).toEqual({ stage: "full", rung: "aal", refusesEveryCredential: true });
    expect(l.signInClosed()).toBe(true);
    expect(l.botStopped()).toBe(false);
    stageFile("aal2");
    l.resetLockdownForTests();
    expect(l.botStopped()).toBe(true);
  });

  it("does not stop the bot for the env floor alone", async () => {
    const l = await load("full");
    expect(l.lockdown().stage).toBe("full");
    expect(l.lockdown().refusesEveryCredential).toBe(false);
    expect(l.signInClosed()).toBe(true);
    expect(l.botStopped()).toBe(false);
  });

  it("keeps sign-in open below `full`", async () => {
    stageFile("admins");
    const l = await load();
    expect(l.signInClosed()).toBe(false);
  });
});

describe("the environment and the SDK agree", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("accepts exactly the SDK's stages as CC_LOCKDOWN, and defaults to the SDK's directory", async () => {
    const { STAGES, DEFAULT_STAGE_DIR } = await import("@ghub/glockdown-sdk");
    for (const stage of STAGES) {
      vi.resetModules();
      vi.stubEnv("CC_LOCKDOWN", stage);
      expect((await import("@/lib/env")).env.CC_LOCKDOWN).toBe(stage);
    }
    vi.resetModules();
    vi.stubEnv("CC_LOCKDOWN", "aal");
    await expect(import("@/lib/env")).rejects.toThrow(/CC_LOCKDOWN/);
    vi.resetModules();
    vi.stubEnv("CC_LOCKDOWN", "off");
    expect((await import("@/lib/env")).env.GLOCKDOWN_STAGE_DIR).toBe(DEFAULT_STAGE_DIR);
  });

  it("fails the boot on a decoy key hash that is not a SHA-256", async () => {
    vi.resetModules();
    vi.stubEnv("GLOCKDOWN_DECOY_KEY_SHA256", `${sha256("a")},not-a-hash`);
    await expect(import("@/lib/env")).rejects.toThrow(/GLOCKDOWN_DECOY_KEY_SHA256/);
  });
});

describe("the ladder", () => {
  beforeEach(() => {
    rmSync(join(dir, "contribution-checker.json"), { force: true });
    vi.unstubAllEnvs();
  });

  it("names the next rung, up to AAL and no further", async () => {
    const l = await load();
    expect(l.nextRung({ stage: "off", rung: null })).toBe("signups");
    expect(l.nextRung({ stage: "admins", rung: "admins" })).toBe("full");
    expect(l.nextRung({ stage: "full", rung: "full" })).toBe("aal");
    // A broken file reads `full` with no rung: the next is still AAL.
    expect(l.nextRung({ stage: "full", rung: null })).toBe("aal");
    expect(l.nextRung({ stage: "full", rung: "aal" })).toBeNull();
    expect(l.nextRung({ stage: "full", rung: "aal2" })).toBeNull();
  });

  it("says what holds the stage in force", async () => {
    let l = await load();
    expect(l.lockdownStatus().heldBy).toBe("nothing");
    stageFile("members");
    l = await load();
    expect(l.lockdownStatus()).toMatchObject({
      stage: "members",
      heldBy: "glockdown",
      rung: "members",
      next: "admins",
    });
    l = await load("admins");
    expect(l.lockdownStatus()).toMatchObject({ stage: "admins", heldBy: "floor" });
    l = await load("members");
    expect(l.lockdownStatus().heldBy).toBe("both");
  });
});

describe("honeytokens", () => {
  beforeEach(() => {
    rmSync(join(dir, "contribution-checker.json"), { force: true });
    vi.unstubAllEnvs();
    for (const f of [...Object.values(sdk), audit.recordAudit]) f.mockReset();
    sdk.signal.mockResolvedValue({ ok: true, body: {} });
    audit.recordAudit.mockResolvedValue({});
    writeFileSync(join(identity, "tls.crt"), "not read by the mocked calls");
    writeFileSync(join(identity, "tls.key"), "not read by the mocked calls");
  });

  it("refuses the decoy admin's names whatever their case, and tells GLockdown once a minute", async () => {
    const l = await load(undefined, { edge: true, logins: "decoy@example.com, cc-ops" });
    expect(l.isDecoyLogin("someone@example.com", "x")).toBe(false);
    expect(l.isDecoyLogin(null, "x")).toBe(false);
    expect(l.isDecoyLogin(" Decoy@Example.COM ", "Hexclave user u1")).toBe(true);
    expect(l.isDecoyLogin("CC-OPS", "Hexclave user u1")).toBe(true);
    await flush();
    expect(sdk.signal).toHaveBeenCalledTimes(1);
    expect(sdk.signal.mock.calls[0][0]).toMatchObject({
      url: "https://127.0.0.1:9",
      edgePins: [PIN],
      signal: "decoy_admin",
      detail: "sign-in as the decoy admin: Hexclave user u1",
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lockdown.decoy_tripped",
        actorId: null,
        payload: expect.objectContaining({ signal: "decoy_admin", told: true }),
      }),
    );
  });

  it("finds the decoy key wherever a request carries it, and never sends the key on", async () => {
    const l = await load(undefined, { edge: true, keys: sha256(DECOY_KEY) });
    const basic = Buffer.from(`admin:${DECOY_KEY}`).toString("base64");
    const carriers = [
      new Request("https://cc.test/api/admin/users", {
        headers: { authorization: `Bearer ${DECOY_KEY}` },
      }),
      new Request("https://cc.test/api/v1/keys", { headers: { authorization: `Basic ${basic}` } }),
      new Request("https://cc.test/api/x", { headers: { "x-api-key": DECOY_KEY } }),
      new Request(`https://cc.test/api/x?api_key=${DECOY_KEY}`),
    ];
    for (const req of carriers) expect(l.presentsDecoyKey(req)).toBe(true);
    expect(
      l.presentsDecoyKey(
        new Request("https://cc.test/api/x", { headers: { authorization: "Bearer real" } }),
      ),
    ).toBe(false);
    await flush();
    expect(sdk.signal).toHaveBeenCalledTimes(1);
    const sent = sdk.signal.mock.calls[0][0] as { signal: string; detail: string };
    expect(sent.signal).toBe("decoy_api_key");
    expect(sent.detail).toBe("the decoy API key used: GET /api/admin/users");
    expect(JSON.stringify(audit.recordAudit.mock.calls)).not.toContain(DECOY_KEY);
  });

  it("bounds what it hashes", async () => {
    const l = await load();
    const params = Array.from({ length: 30 }, (_, i) => `token=k${i}`).join("&");
    const keys = l.presentedKeys(
      new Request(`https://cc.test/api/x?${params}`, {
        headers: { "x-api-key": "k".repeat(5000) },
      }),
    );
    expect(keys.length).toBeLessThanOrEqual(16);
    expect(keys.every((k) => k.length <= 4096)).toBe(true);
  });

  it("checks nothing when no decoy is configured", async () => {
    const l = await load(undefined, { edge: true });
    expect(l.isDecoyLogin("decoy@example.com", "x")).toBe(false);
    expect(
      l.presentsDecoyKey(
        new Request("https://cc.test/api/x", { headers: { authorization: `Bearer ${DECOY_KEY}` } }),
      ),
    ).toBe(false);
  });

  it("still refuses and records a trip when GLockdown cannot be told", async () => {
    const l = await load(undefined, { logins: "decoy@example.com" });
    expect(l.isDecoyLogin("decoy@example.com", "x")).toBe(true);
    await flush();
    expect(sdk.signal).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lockdown.decoy_tripped",
        payload: expect.objectContaining({ told: false, code: "not_configured" }),
      }),
    );
  });
});

describe("the decoy report", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const f of [...Object.values(sdk), audit.recordAudit]) f.mockReset();
    audit.recordAudit.mockResolvedValue({});
    writeFileSync(join(identity, "tls.crt"), "x");
    writeFileSync(join(identity, "tls.key"), "x");
  });

  it("reports hashes only, and audits GLockdown's answer", async () => {
    sdk.reportDecoys.mockResolvedValue({ ok: true, body: { judged: 2, unknown: 0 } });
    const l = await load(undefined, {
      edge: true,
      logins: "Decoy@Example.com",
      keys: sha256(DECOY_KEY),
    });
    const r = await l.reportDecoyInventory("daily");
    expect(r.ok).toBe(true);
    expect(sdk.reportDecoys).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [sha256(DECOY_KEY)],
        logins: [sha256("decoy@example.com")],
      }),
    );
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lockdown.decoys_reported",
        payload: { trigger: "daily", logins: 1, keys: 1, answer: { judged: 2, unknown: 0 } },
      }),
    );
  });

  it("reports an empty set too, which is the case GLockdown checks for", async () => {
    sdk.reportDecoys.mockResolvedValue({ ok: true, body: {} });
    const l = await load(undefined, { edge: true });
    await l.reportDecoyInventory("start");
    expect(sdk.reportDecoys).toHaveBeenCalledWith(
      expect.objectContaining({ keys: [], logins: [] }),
    );
  });

  it("audits a refused report, and asks nothing without an edge", async () => {
    sdk.reportDecoys.mockResolvedValue({ ok: false, status: 403, code: "not_pinned" });
    let l = await load(undefined, { edge: true });
    await l.reportDecoyInventory("console", "user-1");
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lockdown.decoys_report_failed",
        actorId: "user-1",
        payload: expect.objectContaining({ status: 403, code: "not_pinned" }),
      }),
    );
    audit.recordAudit.mockClear();
    l = await load();
    expect(await l.reportDecoyInventory("daily")).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });
});

describe("raising one rung", () => {
  beforeEach(() => {
    rmSync(join(dir, "contribution-checker.json"), { force: true });
    vi.unstubAllEnvs();
    for (const f of [...Object.values(sdk), audit.recordAudit]) f.mockReset();
    audit.recordAudit.mockResolvedValue({});
    writeFileSync(join(identity, "tls.crt"), "x");
    writeFileSync(join(identity, "tls.key"), "x");
  });

  it("asks GLockdown with the reason, and audits from where to where", async () => {
    stageFile("members");
    sdk.escalate.mockResolvedValue({ ok: true, body: { rung: "admins" } });
    const l = await load(undefined, { edge: true });
    const r = await l.raiseOneRung({ reason: "  odd sign-ins  ", actorId: "u1", via: "console" });
    expect(r).toMatchObject({ ok: true, from: "members", expected: "admins" });
    expect(sdk.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "odd sign-ins", edgePins: [PIN] }),
    );
    expect(sdk.escalate.mock.calls[0][0]).not.toHaveProperty("apps");
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lockdown.escalated",
        actorId: "u1",
        payload: expect.objectContaining({ from: "members", expected: "admins", via: "console" }),
      }),
    );
  });

  it("never lets two raises overlap, so a double submit cannot raise two rungs", async () => {
    let answer: (v: unknown) => void = () => {};
    sdk.escalate.mockReturnValue(new Promise((r) => (answer = r)));
    const l = await load(undefined, { edge: true });
    const first = l.raiseOneRung({ reason: "r", actorId: "u1", via: "console" });
    const second = await l.raiseOneRung({ reason: "r", actorId: "u1", via: "console" });
    expect(second).toMatchObject({ ok: false, code: "in_progress" });
    answer({ ok: true, body: {} });
    expect(await first).toMatchObject({ ok: true });
    expect(sdk.escalate).toHaveBeenCalledTimes(1);
  });

  it("refuses without a reason or an edge, and audits GLockdown's refusal", async () => {
    let l = await load(undefined, { edge: true });
    expect(await l.raiseOneRung({ reason: " ", actorId: "u1", via: "console" })).toMatchObject({
      ok: false,
      code: "no_reason",
    });
    expect(sdk.escalate).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();

    sdk.escalate.mockResolvedValue({ ok: false, status: 409, code: "at_ceiling" });
    expect(await l.raiseOneRung({ reason: "r", actorId: null, via: "cli" })).toMatchObject({
      ok: false,
      status: 409,
      code: "at_ceiling",
    });
    expect(audit.recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "lockdown.escalate_failed" }),
    );

    sdk.escalate.mockClear();
    l = await load();
    expect(await l.raiseOneRung({ reason: "r", actorId: null, via: "cli" })).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    expect(sdk.escalate).not.toHaveBeenCalled();
  });
});

describe("the console's view of the edge and the identity", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const f of Object.values(sdk)) f.mockReset();
    writeFileSync(join(identity, "tls.crt"), "x");
    writeFileSync(join(identity, "tls.key"), "x");
  });

  it("reads the edge's answer, and says so when it is not this app's stage", async () => {
    const l = await load(undefined, { edge: true });
    sdk.askStage.mockResolvedValue({
      ok: true,
      body: { v: 1, app: "contribution-checker", rung: "admins", stage: "admins", at: 5 },
    });
    expect(await l.askEdgeNow()).toEqual({
      asked: true,
      ok: true,
      app: "contribution-checker",
      stage: "admins",
      rung: "admins",
      at: 5,
    });
    sdk.askStage.mockResolvedValue({ ok: true, body: { app: "gadvisory", stage: "off" } });
    expect(await l.askEdgeNow()).toMatchObject({ ok: false, code: "unexpected_answer" });
    sdk.askStage.mockResolvedValue({ ok: false, status: 0, code: "unavailable", detail: "the edge's key is not pinned" });
    expect(await l.askEdgeNow()).toMatchObject({
      ok: false,
      detail: "the edge's key is not pinned",
    });
    expect(await (await load()).askEdgeNow()).toMatchObject({ asked: false });
  });

  it.skipIf(!hasOpenssl())("shows the identity's pin, the key it pairs with, and malformed pins", async () => {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", join(identity, "tls.key"), "-out", join(identity, "tls.crt"),
      "-days", "2", "-subj", "/CN=contribution-checker",
    ], { stdio: "ignore" });
    vi.resetModules();
    vi.stubEnv("GLOCKDOWN_IDENTITY_DIR", identity);
    vi.stubEnv("GLOCKDOWN_EDGE_PINS", `${PIN},short`);
    const l = await import("@/lib/lockdown");
    const { spkiPin } = await import("@ghub/glockdown-sdk");
    const { readFileSync } = await import("node:fs");
    const report = l.inspectIdentity();
    expect(report.problem).toBeNull();
    expect(report.certificate).toMatchObject({
      subject: "CN=contribution-checker",
      key: "matches",
      pin: spkiPin(readFileSync(join(identity, "tls.crt"), "utf8")),
    });
    expect(report.edgePins).toEqual([
      { pin: PIN, wellFormed: true },
      { pin: "short", wellFormed: false },
    ]);
    rmSync(join(identity, "tls.key"));
    expect(l.inspectIdentity().certificate?.key).toBe("missing");
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
