import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

/**
 * E11-03: for an App whose key GMint holds, every installation token is
 * GMint's, asked for exactly what one call needs, under the grant
 * `<purpose>-<installation id>` and for the tenant the work is for.
 */
const getToken = vi.fn();
const clientClose = vi.fn();
const clientOptions: unknown[] = [];

vi.mock("@ghub/gmint-sdk", () => {
  // Same `retryable` rule as the SDK: transport, and the protocol's RETRYABLE.
  class GmintError extends Error {
    readonly retryable: boolean;
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(`gmint: ${code}: ${message}`);
      this.name = "GmintError";
      this.retryable =
        code === "transport" ||
        ["unavailable", "rate_limited", "clock"].includes(code);
    }
  }
  class GmintClient {
    constructor(options: unknown) {
      clientOptions.push(options);
    }
    getToken(...a: unknown[]) {
      return getToken(...a);
    }
    close() {
      clientClose();
    }
  }
  return { GmintClient, GmintError };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/env", () => ({ env: { gmint: { appIds: [] } } }));

import { GmintError } from "@ghub/gmint-sdk";
import {
  GmintTokens,
  REUSE_MARGIN_MS,
  isGmintOutage,
  watchGmint,
  type GmintSettings,
  type TokenNeed,
} from "@/lib/github/gmint-tokens";
import { classifyGithubError } from "@/lib/github/errors";

const CLIENT: NonNullable<GmintSettings["client"]> = {
  url: "https://mint.example.org:8443",
  instance: "prod-1",
  clientId: "gmint://contribution-checker/app",
  signingKey: { kid: "cc-app-1", file: "/etc/cc/gmint/sign.pem" },
  tls: {
    certFile: "/var/lib/cc/gmint/client.pem",
    keyFile: "/etc/cc/gmint/client.key",
    caFile: "/etc/cc/gmint/root.pem",
  },
  serverKeys: { "gmint-resp-1": "A".repeat(43) },
  sequenceFile: "/var/lib/cc/gmint/sequence",
};

const APP_ID = "3578217";
const INSTALLATION = 91234567;
const HOUR = 3600_000;

let clock = 1_800_000_000_000;
const now = () => clock;

function tokens(
  client: GmintSettings["client"] | null = CLIENT,
  appIds = [APP_ID],
): GmintTokens {
  return new GmintTokens({ appIds, client: client ?? undefined }, now);
}

let issued = 0;
function token(expiresInMs = HOUR) {
  issued++;
  const secret = `ghs_gmint${issued}`;
  return { expiresAt: new Date(clock + expiresInMs), reveal: () => secret };
}

const NEED: TokenNeed = {
  purpose: "check-run",
  repositories: ["postiz-app"],
  permissions: { checks: "write" },
};

beforeEach(() => {
  issued = 0;
  clock = 1_800_000_000_000;
  clientOptions.length = 0;
  getToken.mockReset();
  getToken.mockImplementation(async () => token());
  clientClose.mockReset();
});

describe("GmintTokens", () => {
  it("knows the Apps whose key GMint holds", () => {
    const t = tokens();
    expect(t.manages(APP_ID)).toBe(true);
    expect(t.manages(` ${APP_ID} `)).toBe(true);
    expect(t.manages("1143465")).toBe(false);
  });

  it("asks for the grant of this purpose and installation, exactly the need, metadata and the tenant", async () => {
    await expect(
      tokens().token(INSTALLATION, NEED, "project:p1"),
    ).resolves.toBe("ghs_gmint1");
    expect(getToken).toHaveBeenCalledWith({
      grant: `check-run-${INSTALLATION}`,
      installationId: INSTALLATION,
      repositories: ["postiz-app"],
      permissions: { metadata: "read", checks: "write" },
      tenant: "project:p1",
      purpose: "check-run",
    });
  });

  it("builds the client only when the first token is asked for, with GMint's settings", async () => {
    const t = tokens();
    expect(clientOptions).toHaveLength(0);
    await t.token(INSTALLATION, NEED, "project:p1");
    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]).toMatchObject(CLIENT);
  });

  it("asks for an org-scoped token when the need names no repository, for the instance", async () => {
    await tokens().token(
      INSTALLATION,
      { purpose: "repo-link", permissions: {} },
      "instance",
    );
    const req = getToken.mock.calls[0][0];
    expect(req).not.toHaveProperty("repositories");
    expect(req).toMatchObject({
      grant: `repo-link-${INSTALLATION}`,
      permissions: { metadata: "read" },
      tenant: "instance",
    });
  });

  it("reuses a token for the same need and tenant while more than five minutes are left", async () => {
    const t = tokens();
    await t.token(INSTALLATION, NEED, "project:p1");
    // Same need, repositories and permissions in another order: same token.
    await t.token(
      INSTALLATION,
      { ...NEED, permissions: { checks: "write", metadata: "read" } },
      "project:p1",
    );
    clock += HOUR - REUSE_MARGIN_MS - 1;
    await expect(t.token(INSTALLATION, NEED, "project:p1")).resolves.toBe(
      "ghs_gmint1",
    );
    expect(getToken).toHaveBeenCalledTimes(1);

    // Another tenant, another permission set, another purpose: each its own.
    await t.token(INSTALLATION, NEED, "project:p2");
    await t.token(
      INSTALLATION,
      { ...NEED, permissions: { checks: "read" } },
      "project:p1",
    );
    await t.token(
      INSTALLATION,
      { ...NEED, purpose: "pr-actions", permissions: { checks: "write" } },
      "project:p1",
    );
    expect(getToken).toHaveBeenCalledTimes(4);
  });

  it("mints again once a token is within five minutes of its end", async () => {
    const t = tokens();
    await t.token(INSTALLATION, NEED, "project:p1");
    clock += HOUR - REUSE_MARGIN_MS;
    await expect(t.token(INSTALLATION, NEED, "project:p1")).resolves.toBe(
      "ghs_gmint2",
    );
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("shares one mint between concurrent asks for the same need", async () => {
    const t = tokens();
    const all = await Promise.all([
      t.token(INSTALLATION, NEED, "project:p1"),
      t.token(INSTALLATION, NEED, "project:p1"),
      t.token(INSTALLATION, NEED, "project:p1"),
    ]);
    expect(all).toEqual(["ghs_gmint1", "ghs_gmint1", "ghs_gmint1"]);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("forgets an installation's tokens, and only that installation's", async () => {
    const t = tokens();
    await t.token(INSTALLATION, NEED, "project:p1");
    await t.token(INSTALLATION + 1, NEED, "project:p1");
    t.forget(INSTALLATION);
    await expect(t.token(INSTALLATION, NEED, "project:p1")).resolves.toBe(
      "ghs_gmint3",
    );
    await expect(t.token(INSTALLATION + 1, NEED, "project:p1")).resolves.toBe(
      "ghs_gmint2",
    );
    t.forgetAll();
    await t.token(INSTALLATION + 1, NEED, "project:p1");
    expect(getToken).toHaveBeenCalledTimes(4);
  });

  it("says a lockdown is a lockdown, a refusal is forbidden, and an unverified answer is an error", async () => {
    const t = tokens();
    for (const [code, status, retryable] of [
      ["locked_down", 503, false],
      ["denied", 403, false],
      ["quarantined", 403, false],
      ["approval_required", 403, false],
      ["untrusted", 500, false],
      ["unavailable", 503, true],
      ["rate_limited", 503, true],
      ["transport", 503, true],
    ] as const) {
      getToken.mockRejectedValueOnce(new GmintError(code, "refused"));
      await expect(
        t.token(INSTALLATION, NEED, "project:p1"),
      ).rejects.toMatchObject({
        name: "GmintRefusal",
        code,
        status,
        retryable,
      });
    }
    // A refusal is not cached: the next ask goes to GMint again.
    await expect(t.token(INSTALLATION, NEED, "project:p1")).resolves.toBe(
      "ghs_gmint1",
    );
  });

  it("passes anything that is not GMint's own error through unchanged", async () => {
    const boom = new Error("boom");
    getToken.mockRejectedValueOnce(boom);
    await expect(
      tokens().token(INSTALLATION, NEED, "project:p1"),
    ).rejects.toBe(boom);
  });

  it("mints nothing for a listed App without GMint's client settings", async () => {
    await expect(
      tokens(null).token(INSTALLATION, NEED, "project:p1"),
    ).rejects.toMatchObject({ code: "unconfigured", status: 503 });
    expect(clientOptions).toHaveLength(0);
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("classifyGithubError on a GMint refusal", () => {
  it("stops a refusal, a lockdown and an unverified answer, and retries an outage", async () => {
    const t = tokens();
    const refusals: unknown[] = [];
    for (const code of ["denied", "locked_down", "untrusted", "unavailable"]) {
      getToken.mockRejectedValueOnce(new GmintError(code as "denied", "x"));
      refusals.push(
        await t.token(INSTALLATION, NEED, "project:p1").catch((e) => e),
      );
    }
    const [denied, lockedDown, untrusted, unavailable] =
      refusals.map(classifyGithubError);
    for (const failure of [denied, lockedDown, untrusted]) {
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect((failure as ApplicationFailure).nonRetryable).toBe(true);
      expect((failure as ApplicationFailure).type).toBe("GmintRefused");
    }
    expect(unavailable).toBe(refusals[3]);
  });
});

// Every GitHub write catches its own failure, so the outage has to be noted
// where each caller receives it, before anybody can swallow it.
describe("watchGmint", () => {
  const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

  it("hears of GMint not answering even when the work swallowed it", async () => {
    getToken.mockRejectedValueOnce(new GmintError("transport", "down"));
    const t = tokens();
    const watched = await watchGmint(async () => {
      await swallow(t.token(INSTALLATION, NEED, "project:p1"));
      return "done";
    });
    expect(watched.value).toBe("done");
    expect(watched.outage).toMatchObject({ code: "transport", retryable: true });
  });

  // Concurrent asks share one mint; each caller's work must hear of it.
  it("tells every work that shared the failed mint", async () => {
    let fail!: (e: unknown) => void;
    getToken.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const t = tokens();
    const both = Promise.all(
      [1, 2].map(() => watchGmint(() => swallow(t.token(INSTALLATION, NEED, "project:p1")))),
    );
    await new Promise((r) => setTimeout(r, 0));
    fail(new GmintError("unavailable", "sealed"));
    const [a, b] = await both;
    expect(a.outage?.code).toBe("unavailable");
    expect(b.outage?.code).toBe("unavailable");
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("does not take a lockdown, a refusal or an unverified answer for an outage", async () => {
    const t = tokens();
    for (const code of ["locked_down", "denied", "untrusted"]) {
      getToken.mockRejectedValueOnce(new GmintError(code as "denied", "x"));
      const watched = await watchGmint(() => swallow(t.token(INSTALLATION, NEED, "project:p1")));
      expect(watched.outage).toBeNull();
    }
    expect(isGmintOutage(new Error("GMint is not answering"))).toBe(false);
  });

  it("keeps each work's outage to itself", async () => {
    const t = tokens();
    getToken.mockRejectedValueOnce(new GmintError("transport", "down"));
    const first = await watchGmint(() => swallow(t.token(INSTALLATION, NEED, "project:p1")));
    const second = await watchGmint(() => t.token(INSTALLATION, NEED, "project:p1"));
    expect(first.outage).not.toBeNull();
    expect(second.outage).toBeNull();
    // Outside any watch a refusal is only thrown, as before.
    getToken.mockRejectedValueOnce(new GmintError("transport", "down"));
    await expect(tokens().token(INSTALLATION, NEED, "project:p1")).rejects.toMatchObject({ code: "transport" });
  });
});
