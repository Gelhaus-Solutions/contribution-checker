import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwsCredentialProvider,
  AwsCredentialsError,
  buildVaultAwsLoginBody,
  signV4,
  STS_BODY,
  STS_URL,
  type AwsCredentials,
} from "@/lib/vault/aws-iam";
import { VaultClient, VaultNetworkError } from "@/lib/vault/client";
import {
  getVaultConfig,
  invalidateVaultConfig,
  type VaultConfig,
} from "@/lib/vault/config";

// The AWS SigV4 test suite's credentials and clock.
const EXAMPLE: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const SUITE_DATE = new Date("2015-08-30T12:36:00Z");
const suite = { region: "us-east-1", service: "service", credentials: EXAMPLE, date: SUITE_DATE };

const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("signV4", () => {
  it("matches the get-vanilla vector", () => {
    const headers = signV4(
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      suite
    );
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers.host).toBe("example.amazonaws.com");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });

  it("matches the post-vanilla vector", () => {
    const headers = signV4(
      { method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      suite
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
    );
  });

  // Reference signature computed with botocore's SigV4Auth.
  it("encodes path segments twice and sorts the query", () => {
    const headers = signV4(
      {
        method: "GET",
        url: "https://example.amazonaws.com/a%20b/c~d?b=2&a=1&a=0&x=%2A",
        headers: {},
        body: "",
      },
      { ...suite, region: "eu-central-1" }
    );
    expect(headers.authorization).toContain(
      "Signature=7d5d21bd5f790ce061b1704bdfa7a5d9ba6a9212dc8943a34c0d8d79b4dad2eb"
    );
  });
});

describe("buildVaultAwsLoginBody", () => {
  it("builds a signed GetCallerIdentity with the token and server id", () => {
    const body = buildVaultAwsLoginBody({
      role: "contribution-checker",
      credentials: { ...EXAMPLE, sessionToken: "session-token-example" },
      iamServerId: "vault.egelhaus.de",
      date: SUITE_DATE,
    });
    expect(body.role).toBe("contribution-checker");
    expect(body.iam_http_request_method).toBe("POST");
    expect(fromB64(body.iam_request_url)).toBe("https://sts.amazonaws.com/");
    expect(fromB64(body.iam_request_body)).toBe(
      "Action=GetCallerIdentity&Version=2011-06-15"
    );
    const headers = JSON.parse(fromB64(body.iam_request_headers)) as Record<
      string,
      string[]
    >;
    expect(Object.keys(headers).sort()).toEqual([
      "authorization",
      "content-type",
      "host",
      "x-amz-date",
      "x-amz-security-token",
      "x-vault-aws-iam-server-id",
    ]);
    expect(headers.host).toEqual(["sts.amazonaws.com"]);
    expect(headers["content-type"]).toEqual([
      "application/x-www-form-urlencoded; charset=utf-8",
    ]);
    expect(headers["x-amz-security-token"]).toEqual(["session-token-example"]);
    expect(headers["x-vault-aws-iam-server-id"]).toEqual(["vault.egelhaus.de"]);
    // Reference signature computed with botocore's SigV4Auth for the same request.
    expect(headers.authorization).toEqual([
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/sts/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-vault-aws-iam-server-id, " +
        "Signature=45627d5ffaa31fa829abb0fa842664efe40d22755bf194f89588b4e46b72c856",
    ]);
  });

  it("leaves out the token and server id headers when there are none", () => {
    const body = buildVaultAwsLoginBody({ role: "r", credentials: EXAMPLE, date: SUITE_DATE });
    const headers = JSON.parse(fromB64(body.iam_request_headers)) as Record<
      string,
      string[]
    >;
    expect(Object.keys(headers).sort()).toEqual([
      "authorization",
      "content-type",
      "host",
      "x-amz-date",
    ]);
    expect(headers.authorization![0]).toContain("SignedHeaders=content-type;host;x-amz-date,");
    expect(STS_URL).toBe("https://sts.amazonaws.com/");
    expect(STS_BODY).toBe("Action=GetCallerIdentity&Version=2011-06-15");
  });
});

describe("AwsCredentialProvider", () => {
  const RELATIVE_URI = "/v2/credentials/abc";
  const containerCreds = (expiration?: string) => ({
    AccessKeyId: "ASIAEXAMPLE",
    SecretAccessKey: "secret",
    Token: "token",
    ...(expiration ? { Expiration: expiration } : {}),
  });

  it("prefers credentials in the environment", async () => {
    const fetchMock = vi.fn();
    const provider = new AwsCredentialProvider({
      env: {
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_SESSION_TOKEN: "t",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.get()).resolves.toEqual({
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      sessionToken: "t",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the task role and caches it until 5 minutes before expiry", async () => {
    let now = Date.parse("2026-11-08T10:00:00Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(containerCreds("2026-11-08T11:00:00Z")))
      .mockResolvedValueOnce(
        jsonResponse({ ...containerCreds("2026-11-08T12:00:00Z"), Token: "token2" })
      );
    const provider = new AwsCredentialProvider({
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI },
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    await expect(provider.get()).resolves.toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://169.254.170.2/v2/credentials/abc");

    now = Date.parse("2026-11-08T10:54:59Z");
    expect((await provider.get()).sessionToken).toBe("token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = Date.parse("2026-11-08T10:55:00Z");
    expect((await provider.get()).sessionToken).toBe("token2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache credentials without an expiry", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(containerCreds()));
    const provider = new AwsCredentialProvider({
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await provider.get();
    await provider.get();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("separates missing configuration from a failing endpoint", async () => {
    const unconfigured = new AwsCredentialProvider({ env: {} });
    await expect(unconfigured.get()).rejects.toMatchObject({
      name: "AwsCredentialsError",
      transient: false,
    });

    const failing = new AwsCredentialProvider({
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI },
      fetchImpl: vi.fn().mockResolvedValue(new Response("down", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(failing.get()).rejects.toMatchObject({ transient: true });

    const unreachable = new AwsCredentialProvider({
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI },
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch,
    });
    await expect(unreachable.get()).rejects.toBeInstanceOf(AwsCredentialsError);
  });
});

describe("getVaultConfig with VAULT_AUTH_METHOD=aws", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("VAULT_")) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_AUTH_METHOD = "aws";
    invalidateVaultConfig();
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("VAULT_")) delete process.env[k];
    }
    Object.assign(process.env, saved);
    invalidateVaultConfig();
  });

  it("requires VAULT_AWS_ROLE", () => {
    expect(() => getVaultConfig()).toThrow(/VAULT_AWS_ROLE/);
  });

  it("defaults the mount and passes the server id", () => {
    process.env.VAULT_AWS_ROLE = "contribution-checker";
    process.env.VAULT_AWS_IAM_SERVER_ID = "vault.egelhaus.de";
    expect(getVaultConfig().auth).toEqual({
      method: "aws",
      role: "contribution-checker",
      mountPath: "aws",
      iamServerId: "vault.egelhaus.de",
    });
  });

  it("trims slashes from a custom mount", () => {
    process.env.VAULT_AWS_ROLE = "r";
    process.env.VAULT_AWS_MOUNT = "/aws-ecs/";
    expect(getVaultConfig().auth).toEqual({ method: "aws", role: "r", mountPath: "aws-ecs" });
  });
});

describe("VaultClient with AWS IAM auth", () => {
  const config: VaultConfig = {
    addr: "https://vault.example.com",
    auth: { method: "aws", role: "cc", mountPath: "aws", iamServerId: "vault.example.com" },
    cacheTtlSeconds: 300,
    revalidateIntervalSeconds: 0,
    timeoutMs: 5000,
    maxRetries: 0,
    breakerThreshold: 5,
    breakerCooldownMs: 30000,
    transitMount: "transit",
    transitKey: "contribution-checker",
  };
  const creds = async (): Promise<AwsCredentials> => ({ ...EXAMPLE, sessionToken: "tok" });
  const noSleep = async (): Promise<void> => {};

  it("logs in with a signed STS request, then reads with the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: "s.aws", lease_duration: 3600 } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "again" } } }));
    const client = new VaultClient(
      config,
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep,
      creds
    );

    expect((await client.readKvV2("secret/data/foo")).value).toBe("ok");
    const [loginUrl, loginInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(loginUrl).toBe("https://vault.example.com/v1/auth/aws/login");
    expect(loginInit.method).toBe("POST");
    expect((loginInit.headers as Headers).get("x-vault-token")).toBeNull();
    const body = JSON.parse(loginInit.body as string) as Record<string, string>;
    expect(body.role).toBe("cc");
    expect(body.iam_http_request_method).toBe("POST");
    expect(fromB64(body.iam_request_url!)).toBe(STS_URL);
    const signed = JSON.parse(fromB64(body.iam_request_headers!)) as Record<string, string[]>;
    expect(signed["x-amz-security-token"]).toEqual(["tok"]);
    expect(signed["x-vault-aws-iam-server-id"]).toEqual(["vault.example.com"]);

    const readHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers;
    expect(readHeaders.get("x-vault-token")).toBe("s.aws");

    // The token is cached with its lease: no second login.
    expect((await client.readKvV2("secret/data/foo")).value).toBe("again");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("logs in again after a 403 on a cached token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ auth: { client_token: "s.first", lease_duration: 3600 } }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ auth: { client_token: "s.second", lease_duration: 3600 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));
    const client = new VaultClient(config, 5000, fetchMock as unknown as typeof fetch, noSleep, creds);
    expect((await client.readKvV2("secret/data/foo")).value).toBe("ok");
    expect(fetchMock.mock.calls[2]![0]).toBe("https://vault.example.com/v1/auth/aws/login");
    expect(
      ((fetchMock.mock.calls[3]![1] as RequestInit).headers as Headers).get("x-vault-token")
    ).toBe("s.second");
  });

  it("retries a failing credential endpoint like a Vault outage", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new AwsCredentialsError("endpoint down", true))
      .mockImplementation(creds);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ auth: { client_token: "s.aws", lease_duration: 3600 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { data: { value: "ok" } } }));
    const client = new VaultClient(
      { ...config, maxRetries: 1 },
      5000,
      fetchMock as unknown as typeof fetch,
      noSleep,
      flaky
    );
    expect((await client.readKvV2("secret/data/foo")).value).toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);

    const down = new VaultClient(
      config,
      5000,
      vi.fn() as unknown as typeof fetch,
      noSleep,
      vi.fn().mockRejectedValue(new AwsCredentialsError("endpoint down", true))
    );
    await expect(down.readKvV2("secret/data/foo")).rejects.toBeInstanceOf(VaultNetworkError);
  });
});
