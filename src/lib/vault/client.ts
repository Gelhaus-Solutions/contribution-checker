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

const DEFAULT_TIMEOUT_MS = 5000;
// Renew tokens this many ms before they expire to avoid 403-on-boundary races.
const TOKEN_REFRESH_LEEWAY_MS = 30_000;

export class VaultClient {
  private token: Token | null = null;

  constructor(
    private readonly config: VaultConfig,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
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
