const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-github-token",
]);

const SENSITIVE_FIELD_KEYS = new Set([
  "token",
  "id_token",
  "access_token",
  "refresh_token",
  "session_token",
  "sessiontoken",
  "bearertoken",
  "bearer_token",
  "secret",
  "client_secret",
  "github_app_private_key",
  "auth_secret",
  "smtp_pass",
  "private_key",
  "privatekey",
  "password",
  "api_key",
  "apikey",
]);

const REDACTED = "[Filtered]";

const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SHA256_SIG_RE = /\bsha256=[A-Fa-f0-9]{64}\b/g;
const GH_INSTALL_TOKEN_RE = /\bghs_[A-Za-z0-9]{30,}\b/g;
const GH_USER_TOKEN_RE = /\b(?:ghp|gho|ghu|ghr)_[A-Za-z0-9]{30,}\b/g;

function scrubString(s: string): string {
  return s
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(SHA256_SIG_RE, REDACTED)
    .replace(GH_INSTALL_TOKEN_RE, REDACTED)
    .replace(GH_USER_TOKEN_RE, REDACTED);
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SENSITIVE_HEADER_KEYS.has(k)) return true;
  if (SENSITIVE_FIELD_KEYS.has(k)) return true;
  if (k.endsWith("_token") || k.endsWith("token")) return true;
  if (k.endsWith("_secret") || k.endsWith("secret")) return true;
  if (k.endsWith("_password") || k.endsWith("password")) return true;
  return false;
}

function walk(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (depth > 8) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else if (typeof v === "string") {
        out[k] = scrubString(v);
      } else {
        out[k] = walk(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function scrubSensitive<T>(input: T): T {
  if (input == null) return input;
  return walk(input, 0) as T;
}
