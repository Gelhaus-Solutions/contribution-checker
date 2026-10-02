import type { VaultConfig } from "./config";

export class VaultError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "VaultError";
  }
}
export class VaultAuthError extends VaultError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "VaultAuthError";
  }
}
export class VaultNotFoundError extends VaultError {
  constructor(message: string) {
    super(message, 404);
    this.name = "VaultNotFoundError";
  }
}
export class VaultNetworkError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = "VaultNetworkError";
  }
}

type Token = { value: string; expiresAt: number };

/**
 * The Transit derivation context, base64 as Vault wants it.
 *
 * Production's key was created with `derived=true`, and a derived key refuses
 * any encrypt or decrypt without a context. One fixed context for every
 * credential, so a value encrypted by the app, by `db:encrypt-credentials` or by
 * a later version decrypts the same way. A key without derivation ignores it.
 * Changing this string makes every stored value undecryptable.
 */
export const TRANSIT_CONTEXT = Buffer.from(
  "contribution-checker/credentials",
  "utf8"
).toString("base64");

const DEFAULT_TIMEOUT_MS = 5000;
// Renew tokens this many ms before they expire to avoid 403-on-boundary races.
const TOKEN_REFRESH_LEEWAY_MS = 30_000;
// Backoff base and cap for transient-error retries. With the default 2 retries
// and a 5s per-attempt timeout, worst-case cold-path blocking is roughly
// 3 attempts plus two short sleeps, which stays under GitHub's webhook
// delivery timeout. The warm path never blocks (it revalidates in the
// background), so this budget only applies to a true cold start.
const RETRY_BASE_DELAY_MS = 150;
const RETRY_MAX_DELAY_MS = 1000;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transient errors are worth retrying: network failures, timeouts, and 5xx
 * responses. Auth failures (401/403), 404, and structural errors are not, as a
 * retry would just repeat the same deterministic outcome.
 */
function isTransient(e: unknown): boolean {
  if (e instanceof VaultNetworkError) return true;
  if (e instanceof VaultAuthError) return false;
  if (e instanceof VaultNotFoundError) return false;
  if (e instanceof VaultError) return e.status !== undefined && e.status >= 500;
  return false;
}

export class VaultClient {
  private token: Token | null = null;

  constructor(
    private readonly config: VaultConfig,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly sleepImpl: (ms: number) => Promise<void> = realSleep
  ) {}

  /**
   * Acquire (or reuse) an auth token. Static `token` auth never expires from
   * our perspective. Vault rejects with 403 if the token is invalid, in
   * which case we surface VaultAuthError to the caller.
   */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + TOKEN_REFRESH_LEEWAY_MS) {
      return this.token.value;
    }
    if (this.config.auth.method === "token") {
      this.token = {
        value: this.config.auth.token,
        // Static tokens have no client-side expiry; pick a far-future sentinel.
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      return this.token.value;
    }
    // AppRole login.
    const { roleId, secretId, mountPath } = this.config.auth;
    const res = await this.request(
      `/v1/auth/${mountPath}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      },
      false
    );
    const json = (await res.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const clientToken = json.auth?.client_token;
    const leaseSeconds = json.auth?.lease_duration ?? 0;
    if (!clientToken) {
      throw new VaultAuthError("AppRole login returned no client_token");
    }
    this.token = {
      value: clientToken,
      expiresAt:
        leaseSeconds > 0 ? Date.now() + leaseSeconds * 1000 : Number.MAX_SAFE_INTEGER,
    };
    return clientToken;
  }

  /**
   * Read a KV v2 secret. `fullPath` should be the full path including the
   * `data/` segment (e.g. `secret/data/cc/github`) so operators can copy paths
   * directly from the Vault UI without us having to inject `data/`.
   */
  async readKvV2(fullPath: string): Promise<Record<string, string>> {
    const maxRetries = this.config.maxRetries ?? 0;
    let attempt = 0;
    for (;;) {
      try {
        return await this.readKvV2Once(fullPath);
      } catch (e) {
        if (attempt >= maxRetries || !isTransient(e)) throw e;
        const expo = RETRY_BASE_DELAY_MS * 2 ** attempt;
        // Full jitter keeps concurrent retries from synchronizing.
        const delay = Math.random() * Math.min(RETRY_MAX_DELAY_MS, expo);
        await this.sleepImpl(delay);
        attempt += 1;
      }
    }
  }

  /**
   * Encrypt with the configured Transit key. Returns Vault's native
   * `vault:v<N>:...` envelope, which callers store verbatim. Transient errors
   * are retried like KV reads; a 403 (policy) or 404 (no such key) is not.
   */
  async transitEncrypt(plaintext: string): Promise<string> {
    const res = await this.withRetries(() =>
      this.transitCall("encrypt", {
        plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
        context: TRANSIT_CONTEXT,
      })
    );
    const ct = (res as { data?: { ciphertext?: string } }).data?.ciphertext;
    if (!ct) throw new VaultError("Vault transit encrypt returned no ciphertext");
    return ct;
  }

  /** Decrypt many ciphertexts in one request. Order is preserved. */
  async transitDecryptBatch(ciphertexts: string[]): Promise<string[]> {
    if (ciphertexts.length === 0) return [];
    const res = await this.withRetries(() =>
      this.transitCall("decrypt", {
        batch_input: ciphertexts.map((ciphertext) => ({
          ciphertext,
          context: TRANSIT_CONTEXT,
        })),
      })
    );
    const results = (
      res as {
        data?: { batch_results?: { plaintext?: string; error?: string }[] };
      }
    ).data?.batch_results;
    if (!results || results.length !== ciphertexts.length) {
      throw new VaultError("Vault transit decrypt returned a malformed batch");
    }
    return results.map((r) => {
      // The per-item error is deliberately not echoed: it can name the key.
      if (r.error || r.plaintext === undefined) {
        throw new VaultError("Vault transit decrypt failed for one value", 400);
      }
      return Buffer.from(r.plaintext, "base64").toString("utf8");
    });
  }

  async transitDecrypt(ciphertext: string): Promise<string> {
    const [plaintext] = await this.transitDecryptBatch([ciphertext]);
    return plaintext as string;
  }

  private async transitCall(
    op: "encrypt" | "decrypt",
    body: unknown
  ): Promise<unknown> {
    const mount = this.config.transitMount
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const key = encodeURIComponent(this.config.transitKey);
    const res = await this.request(
      `/v1/${mount}/${op}/${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      true
    );
    return res.json();
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.maxRetries ?? 0;
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= maxRetries || !isTransient(e)) throw e;
        const expo = RETRY_BASE_DELAY_MS * 2 ** attempt;
        await this.sleepImpl(
          Math.random() * Math.min(RETRY_MAX_DELAY_MS, expo)
        );
        attempt += 1;
      }
    }
  }

  private async readKvV2Once(
    fullPath: string
  ): Promise<Record<string, string>> {
    const res = await this.request(`/v1/${fullPath}`, { method: "GET" }, true);
    const json = (await res.json()) as {
      data?: { data?: Record<string, string> };
    };
    const data = json.data?.data;
    if (!data || typeof data !== "object") {
      throw new VaultError(
        `Vault KV v2 response missing data.data at ${fullPath}`
      );
    }
    return data;
  }

  /**
   * Centralized request: handles timeout, namespace header, token header
   * (when authed), and status-to-error mapping. When `authed=true` and the
   * cached token returns 403, we drop it and retry once after re-login.
   * This covers AppRole tokens that expire mid-process.
   */
  private async request(
    path: string,
    init: RequestInit,
    authed: boolean
  ): Promise<Response> {
    const send = async (token: string | null): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = new Headers(init.headers);
        if (this.config.namespace) {
          headers.set("x-vault-namespace", this.config.namespace);
        }
        if (token) headers.set("x-vault-token", token);
        const res = await this.fetchImpl(`${this.config.addr}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
        return res;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new VaultNetworkError(`Vault request timed out: ${path}`);
        }
        throw new VaultNetworkError(
          `Vault request failed: ${path} (${(e as Error).message})`
        );
      } finally {
        clearTimeout(timer);
      }
    };

    let token: string | null = null;
    if (authed) token = await this.getToken();
    let res = await send(token);

    if (authed && res.status === 403) {
      // Token may have expired between cache hit and request. Force re-login.
      this.token = null;
      token = await this.getToken();
      res = await send(token);
    }

    if (res.status === 404) {
      throw new VaultNotFoundError(`Vault path not found: ${path}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new VaultAuthError(
        `Vault auth failed (${res.status}) for ${path}`,
        res.status
      );
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new VaultError(
        `Vault request failed (${res.status}) for ${path}: ${text}`,
        res.status
      );
    }
    return res;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
