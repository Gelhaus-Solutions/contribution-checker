/**
 * Pure helpers for extracting client request metadata (IP + User-Agent) from a
 * Next.js `Headers` object. Used to capture IP/UA on legally-binding CLA
 * signatures and other audited actions.
 */

const DEFAULT_USER_AGENT_MAX_LEN = 512;

/**
 * Resolve the client IP from forwarding headers.
 *
 * Prefers the first entry of `x-forwarded-for`, then `x-real-ip`, falling back
 * to `"unknown"` when neither is present.
 */
export function getClientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

/**
 * Resolve the client User-Agent string, capped at `maxLen` characters.
 *
 * Returns `""` when the header is absent.
 */
export function getClientUserAgent(
  h: Headers,
  maxLen: number = DEFAULT_USER_AGENT_MAX_LEN
): string {
  const ua = h.get("user-agent");
  if (!ua) return "";
  return ua.slice(0, maxLen);
}
