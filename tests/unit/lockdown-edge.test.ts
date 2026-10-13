import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing of the SDK is mocked here: every call goes to a local stand-in for
// GLockdown's edge over real TLS 1.3, pinned both ways, so this is the edge
// wiring of src/lib/lockdown.ts as it runs in production.
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => audit);

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), "cc-glockdown-edge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function selfSigned(name: string): { cert: string; key: string } {
  const at = join(dir, name);
  mkdirSync(at, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", join(at, "tls.key"), "-out", join(at, "tls.crt"),
      "-days", "2", "-subj", `/CN=${name}`,
    ],
    { stdio: "ignore" },
  );
  return {
    cert: readFileSync(join(at, "tls.crt"), "utf8"),
    key: readFileSync(join(at, "tls.key"), "utf8"),
  };
}

const pinOf = (pem: string) =>
  createHash("sha256")
    .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url");

const APP = "contribution-checker";

describe.skipIf(!hasOpenssl())("GLockdown's edge, over real pinned TLS", () => {
  let server: Server;
  let url = "";
  let edgePin = "";
  let appPin = "";
  let stage = { v: 1, app: APP, rung: "admins", stage: "admins", at: 1_791_900_000 };
  const received: { path: string; body: unknown; clientPin: string | null }[] = [];

  beforeAll(async () => {
    const edge = selfSigned("edge");
    const app = selfSigned("app");
    edgePin = pinOf(edge.cert);
    appPin = pinOf(app.cert);
    server = createServer(
      { cert: edge.cert, key: edge.key, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const peer = (req.socket as TLSSocket).getPeerX509Certificate();
          received.push({
            path: req.url ?? "",
            body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
            clientPin: peer ? pinOf(peer.toString()) : null,
          });
          res.setHeader("content-type", "application/json");
          if (req.url === "/v1/stage") return res.end(JSON.stringify(stage));
          if (req.url === "/v1/escalate") {
            stage = { ...stage, rung: "full", stage: "full" };
            return res.end(JSON.stringify({ rung: "full" }));
          }
          if (req.url === "/v1/decoyset") return res.end(JSON.stringify({ judged: 2, unlisted: 0 }));
          if (req.url === "/v1/signal") return res.end(JSON.stringify({ raised: "aal" }));
          res.statusCode = 404;
          res.end(JSON.stringify({ code: "not_found" }));
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    stage = { v: 1, app: APP, rung: "admins", stage: "admins", at: 1_791_900_000 };
    received.length = 0;
    audit.recordAudit.mockClear();
    vi.unstubAllEnvs();
  });

  async function load(pins = edgePin, decoys = "") {
    vi.resetModules();
    // No stage file: the agent is not installed, so the edge is the stricter.
    vi.stubEnv("GLOCKDOWN_STAGE_DIR", join(dir, "no-agent"));
    vi.stubEnv("CC_LOCKDOWN", "off");
    vi.stubEnv("GLOCKDOWN_EDGE_URL", url);
    vi.stubEnv("GLOCKDOWN_EDGE_PINS", pins);
    vi.stubEnv("GLOCKDOWN_IDENTITY_DIR", join(dir, "app"));
    vi.stubEnv("GLOCKDOWN_DECOY_LOGIN", decoys);
    vi.stubEnv("GLOCKDOWN_DECOY_KEY_SHA256", "");
    return import("@/lib/lockdown");
  }

  it("takes the edge's answer as the stage in force, asked as this app", async () => {
    const l = await load();
    await l.refreshFromEdge();
    expect(l.lockdown()).toMatchObject({ stage: "admins", rung: "admins" });
    expect(l.lockdownStatus().reading.source).toBe("edge");
    expect(received.at(-1)).toEqual({ path: "/v1/stage", body: null, clientPin: appPin });
    expect(await l.askEdgeNow()).toMatchObject({ asked: true, ok: true, rung: "admins" });
  });

  it("raises one rung, and the stage in force follows at once", async () => {
    const l = await load();
    // Reading the stage starts a background ask; the raise must not take that
    // stale answer for the one after it.
    expect(l.lockdown().stage).toBe("off");
    const r = await l.raiseOneRung({ reason: "edge test", actorId: null, via: "cli" });
    expect(r).toMatchObject({ ok: true, from: "admins", expected: "full" });
    expect(received.find((x) => x.path === "/v1/escalate")).toEqual({
      path: "/v1/escalate",
      body: { apps: null, reason: "edge test" },
      clientPin: appPin,
    });
    expect(l.lockdown().stage).toBe("full");
  });

  it("sends nothing when the stage moved past the rung the caller decided from", async () => {
    const l = await load();
    const r = await l.raiseOneRung({
      reason: "stale form",
      actorId: "u1",
      via: "console",
      expectFrom: "members",
    });
    expect(r).toMatchObject({ ok: false, code: "stage_moved", from: "admins" });
    expect(received.some((x) => x.path === "/v1/escalate")).toBe(false);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it("reports the decoys and signals a trip, as hashes and names only", async () => {
    const l = await load(edgePin, "decoy@example.com");
    expect((await l.reportDecoyInventory("start")).ok).toBe(true);
    expect(received.find((x) => x.path === "/v1/decoyset")?.body).toEqual({
      keys: [],
      logins: [createHash("sha256").update("decoy@example.com").digest("hex")],
    });
    expect(l.isDecoyLogin("decoy@example.com", "Hexclave user u9")).toBe(true);
    await vi.waitFor(() => expect(received.some((x) => x.path === "/v1/signal")).toBe(true));
    expect(received.find((x) => x.path === "/v1/signal")?.body).toEqual({
      signal: "decoy_admin",
      detail: "sign-in as the decoy admin: Hexclave user u9",
    });
  });

  it("talks to no edge whose key is not pinned", async () => {
    const l = await load("A".repeat(43));
    expect(await l.askEdgeNow()).toMatchObject({
      asked: true,
      ok: false,
      detail: "the edge's key is not pinned",
    });
    await l.refreshFromEdge();
    expect(l.lockdown().stage).toBe("off");
    expect(received).toHaveLength(0);
  });
});
