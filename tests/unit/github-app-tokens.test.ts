import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * E11-03: `getInstallationOctokit` takes a GMint-held App's token from GMint,
 * for exactly the caller's need, and never reads that App's key; any other App
 * keeps minting with its own key, need or not. The budget accounting applies to
 * both, and a GitHub 401 forgets the installation's GMint tokens.
 */
const secrets: Record<string, string | undefined> = {};
const getSecret = vi.fn(async (name: string) => secrets[name]);
vi.mock("@/lib/vault/resolver", () => ({
  getSecret: (name: string) => getSecret(name),
}));

const appOptions: unknown[] = [];
const keyPathInstallationOctokit = vi.fn();
vi.mock("@octokit/app", () => ({
  App: class {
    constructor(options: unknown) {
      appOptions.push(options);
    }
    getInstallationOctokit(id: number) {
      return keyPathInstallationOctokit(id);
    }
  },
}));

const getToken = vi.fn();
vi.mock("@ghub/gmint-sdk", () => ({
  GmintError: class GmintError extends Error {},
  GmintClient: class {
    getToken(...a: unknown[]) {
      return getToken(...a);
    }
    close() {}
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const GMINT_APP = "3578217";
const OWN_KEY_APP = "1143465";
vi.mock("@/lib/env", () => ({
  env: {
    gmint: {
      appIds: ["3578217"],
      client: {
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
      },
    },
  },
}));

import {
  getGitHubApp,
  getInstallationOctokit,
  invalidateGitHubAppCache,
} from "@/lib/github/app";
import {
  resetGmintTokensForTests,
  type TokenNeed,
} from "@/lib/github/gmint-tokens";
import { budgetSnapshot, resetBudgetForTests } from "@/lib/github/budget";

const INSTALLATION = 91234567;
const NEED: TokenNeed = {
  purpose: "pr-actions",
  repositories: ["postiz-app"],
  permissions: { pull_requests: "write", issues: "write" },
};

let issued = 0;

/** A GitHub that answers every request with `status` and records the auth. */
function github(status = 200) {
  const seen: string[] = [];
  const body = status === 200 ? { id: 1 } : { message: "Bad credentials" };
  const fetch = vi.fn(
    async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.authorization);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { fetch, seen };
}

beforeEach(() => {
  for (const k of Object.keys(secrets)) delete secrets[k];
  Object.assign(secrets, {
    GITHUB_APP_ID: GMINT_APP,
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN RSA PRIVATE KEY-----\\nkey\\n-----END RSA PRIVATE KEY-----\\n",
    GITHUB_APP_WEBHOOK_SECRET: "whsec",
  });
  getSecret.mockClear();
  appOptions.length = 0;
  keyPathInstallationOctokit.mockReset();
  keyPathInstallationOctokit.mockImplementation(async () => ({
    hook: { wrap: vi.fn() },
  }));
  issued = 0;
  getToken.mockReset();
  getToken.mockImplementation(async () => {
    issued++;
    const secret = `ghs_gmint${issued}`;
    return {
      expiresAt: new Date(Date.now() + 3600_000),
      reveal: () => secret,
    };
  });
  invalidateGitHubAppCache();
  resetGmintTokensForTests();
  resetBudgetForTests();
});

describe("getInstallationOctokit for an App whose key GMint holds", () => {
  it("takes the token from GMint for exactly the need and tenant, and never reads the key", async () => {
    const gh = github();
    const octokit = await getInstallationOctokit(
      INSTALLATION,
      NEED,
      "project:p1",
    );
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "gitroomhq",
      repo: "postiz-app",
      request: { fetch: gh.fetch },
    });

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledWith({
      grant: `pr-actions-${INSTALLATION}`,
      installationId: INSTALLATION,
      repositories: ["postiz-app"],
      permissions: {
        metadata: "read",
        pull_requests: "write",
        issues: "write",
      },
      tenant: "project:p1",
      purpose: "pr-actions",
    });
    expect(gh.seen).toEqual(["token ghs_gmint1"]);
    expect(appOptions).toHaveLength(0);
    expect(keyPathInstallationOctokit).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalledWith("GITHUB_APP_PRIVATE_KEY");
  });

  it("counts its requests against the installation's budget", async () => {
    const gh = github();
    const octokit = await getInstallationOctokit(
      INSTALLATION,
      NEED,
      "project:p1",
    );
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "gitroomhq",
      repo: "postiz-app",
      request: { fetch: gh.fetch },
    });
    expect(budgetSnapshot(INSTALLATION).used.interactive).toBe(1);
  });

  it("reuses the token across instances, and forgets it after GitHub answers 401", async () => {
    await getInstallationOctokit(INSTALLATION, NEED, "project:p1");
    const octokit = await getInstallationOctokit(
      INSTALLATION,
      NEED,
      "project:p1",
    );
    expect(getToken).toHaveBeenCalledTimes(1);

    const refused = github(401);
    await expect(
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: "gitroomhq",
        repo: "postiz-app",
        request: { fetch: refused.fetch },
      }),
    ).rejects.toMatchObject({ status: 401 });

    const gh = github();
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "gitroomhq",
      repo: "postiz-app",
      request: { fetch: gh.fetch },
    });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(gh.seen).toEqual(["token ghs_gmint2"]);
  });

  it("forgets every GMint token when the App cache is invalidated", async () => {
    await getInstallationOctokit(INSTALLATION, NEED, "project:p1");
    invalidateGitHubAppCache();
    await getInstallationOctokit(INSTALLATION, NEED, "project:p1");
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("has no App object, so App-level calls fail with a clear message", async () => {
    await expect(getGitHubApp()).rejects.toThrow(
      /GMint holds the key of GitHub App 3578217/,
    );
    expect(appOptions).toHaveLength(0);
    expect(getSecret).not.toHaveBeenCalledWith("GITHUB_APP_PRIVATE_KEY");
  });
});

describe("getInstallationOctokit for an App that mints with its own key", () => {
  beforeEach(() => {
    secrets.GITHUB_APP_ID = OWN_KEY_APP;
  });

  it("mints with the App's key and asks GMint nothing, whatever the need", async () => {
    const octokit = await getInstallationOctokit(
      INSTALLATION,
      NEED,
      "project:p1",
    );

    expect(keyPathInstallationOctokit).toHaveBeenCalledWith(INSTALLATION);
    expect(appOptions).toEqual([
      expect.objectContaining({
        appId: OWN_KEY_APP,
        privateKey:
          "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
      }),
    ]);
    expect(getToken).not.toHaveBeenCalled();
    // The budget wrapper is still hooked in.
    expect(octokit.hook.wrap).toHaveBeenCalledWith(
      "request",
      expect.any(Function),
    );
  });

  it("still refuses without a private key", async () => {
    secrets.GITHUB_APP_PRIVATE_KEY = undefined;
    await expect(
      getInstallationOctokit(INSTALLATION, NEED, "project:p1"),
    ).rejects.toThrow(/GitHub App is not configured/);
    expect(getToken).not.toHaveBeenCalled();
  });
});
