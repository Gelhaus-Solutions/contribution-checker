import { createHash, createHmac } from "node:crypto";

/**
 * Vault's AWS IAM login: a SigV4-signed STS GetCallerIdentity request that
 * Vault replays to STS to learn who is asking. Credentials come from the
 * environment or the ECS task role; nothing here needs the AWS SDK.
 */

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/** `transient` separates a credential endpoint that failed from one that is not configured. */
export class AwsCredentialsError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "AwsCredentialsError";
  }
}

const ECS_CREDENTIALS_HOST = "http://169.254.170.2";
const CREDENTIALS_REFRESH_LEEWAY_MS = 5 * 60_000;

export type AwsCredentialProviderOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export class AwsCredentialProvider {
  private cached: { credentials: AwsCredentials; refreshAt: number } | null = null;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(opts: AwsCredentialProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async get(): Promise<AwsCredentials> {
    const env = this.env;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
      };
    }
    if (this.cached && this.now() < this.cached.refreshAt) {
      return this.cached.credentials;
    }
    const relativeUri = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (!relativeUri) {
      throw new AwsCredentialsError(
        "No AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run on ECS with a task role.",
        false
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${ECS_CREDENTIALS_HOST}${relativeUri}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AwsCredentialsError(
        `ECS credential endpoint unreachable (${(e as Error).message})`,
        true
      );
    }
    if (!res.ok) {
      throw new AwsCredentialsError(
        `ECS credential endpoint answered ${res.status}`,
        res.status >= 500 || res.status === 429
      );
    }
    const body = (await res.json().catch(() => null)) as {
      AccessKeyId?: unknown;
      SecretAccessKey?: unknown;
      Token?: unknown;
      Expiration?: unknown;
    } | null;
    if (
      !body ||
      typeof body.AccessKeyId !== "string" ||
      typeof body.SecretAccessKey !== "string"
    ) {
      throw new AwsCredentialsError("ECS credential endpoint returned no keys", true);
    }
    const credentials: AwsCredentials = {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      sessionToken: typeof body.Token === "string" ? body.Token : undefined,
    };
    const expiresAt =
      typeof body.Expiration === "string" ? Date.parse(body.Expiration) : NaN;
    // Without an expiry there is nothing to cache against, so the next call asks again.
    this.cached = {
      credentials,
      refreshAt: Number.isFinite(expiresAt)
        ? expiresAt - CREDENTIALS_REFRESH_LEEWAY_MS
        : 0,
    };
    return credentials;
  }
}

const defaultProvider = new AwsCredentialProvider();

export function defaultAwsCredentials(): Promise<AwsCredentials> {
  return defaultProvider.get();
}

// --- SigV4 ---

export type SignableRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type SigningParams = {
  region: string;
  service: string;
  credentials: AwsCredentials;
  date: Date;
};

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding, which encodeURIComponent misses for !'()*. */
const encodeRfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

function canonicalPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  // Every service but S3 expects each segment encoded twice; the URL parser did the first.
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Signs a request with AWS Signature Version 4 and returns every header to
 * send: the given ones plus host, x-amz-date, x-amz-security-token (with a
 * session token) and authorization. All of them are signed.
 */
export function signV4(
  req: SignableRequest,
  params: SigningParams
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = params.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  headers.host ??= url.host;
  headers["x-amz-date"] = amzDate;
  if (params.credentials.sessionToken) {
    headers["x-amz-security-token"] = params.credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(req.body),
  ].join("\n");

  const scope = `${day}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${params.credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, params.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// --- Vault login ---

export const STS_URL = "https://sts.amazonaws.com/";
export const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";
const IAM_SERVER_ID_HEADER = "x-vault-aws-iam-server-id";

export type VaultAwsLoginBody = {
  role: string;
  iam_http_request_method: "POST";
  iam_request_url: string;
  iam_request_body: string;
  iam_request_headers: string;
};

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** The body for `POST /v1/auth/<mount>/login`, signed for the global STS endpoint. */
export function buildVaultAwsLoginBody(opts: {
  role: string;
  credentials: AwsCredentials;
  iamServerId?: string;
  date?: Date;
}): VaultAwsLoginBody {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
  };
  if (opts.iamServerId) headers[IAM_SERVER_ID_HEADER] = opts.iamServerId;
  const signed = signV4(
    { method: "POST", url: STS_URL, headers, body: STS_BODY },
    {
      region: "us-east-1",
      service: "sts",
      credentials: opts.credentials,
      date: opts.date ?? new Date(),
    }
  );
  return {
    role: opts.role,
    iam_http_request_method: "POST",
    iam_request_url: b64(STS_URL),
    iam_request_body: b64(STS_BODY),
    iam_request_headers: b64(
      JSON.stringify(
        Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, [v]]))
      )
    ),
  };
}
