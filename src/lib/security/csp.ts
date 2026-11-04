/**
 * Content-Security-Policy built at RUNTIME (in middleware), not baked into the
 * build manifest by next.config's headers(). Its runtime inputs (GPID_URL,
 * CSP_EXTRA_DOMAINS, the Sentry report endpoint) are only known at container
 * runtime in our generic CI-built image, so it can't be set at `next build`.
 *
 * Edge-safe: only string building + process.env reads, no Node/Vault.
 */

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Operator-configurable EXTRA domains, appended to the existing CSP's resource
 * directives. One env var, `CSP_EXTRA_DOMAINS`, space- or comma-separated;
 * supports wildcard hosts (e.g. `https://*.example.com`), plain domains, and
 * scheme tokens (`data:`, `blob:`). Read from process.env directly so this stays
 * edge-safe (middleware runs on the edge runtime and can't import the Node env
 * module).
 */
function extraDomains(): string[] {
  const raw = process.env.CSP_EXTRA_DOMAINS;
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sentry CSP report ingest URL (Settings -> Security Headers), if configured. */
export function cspReportEndpoint(): string | null {
  const raw = process.env.SENTRY_CSP_ENDPOINT;
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch {
    return null;
  }
}

export function buildCsp(): string {
  // No sign-in backend is reached from the browser: GPID is spoken to by this
  // server only (src/lib/sso.ts), so nothing of it is in connect-src.

  // Operator-added domains, appended to the resource directives so an allowed
  // domain works wherever the page needs it (connect/img/script/style/font/
  // frame/media/worker). `data:`/`blob:` stay in connect-src for client code
  // that fetch()es a data: or blob: URL; a Fetch is governed by connect-src,
  // not img-src.
  const extra = extraDomains();
  // GPlatform Identity, where the instance reads its catalogue (GPID_URL): the
  // header draws the catalogue's mark, the favicon links it, and the apps
  // picker and account popup draw product marks and pictures from Identity's
  // asset store. Images only; the controls fetch through this origin's own
  // /api/identity-chrome.
  const identityOrigin = originOf(process.env.GPID_URL);

  const directives = [
    ["default-src", "'self'", ...extra],
    [
      "img-src",
      "'self'",
      "https://avatars.githubusercontent.com",
      identityOrigin,
      "data:",
      "blob:",
      ...extra,
    ],
    ["media-src", "'self'", "blob:", ...extra],
    [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "blob:",
      ...extra,
    ],
    ["worker-src", "'self'", "blob:", ...extra],
    ["style-src", "'self'", "'unsafe-inline'", ...extra],
    ["font-src", "'self'", "data:", ...extra],
    [
      "connect-src",
      "'self'",
      "data:",
      "blob:",
      "https://*.sentry.io",
      "https://*.ingest.sentry.io",
      "https://*.ingest.us.sentry.io",
      "https://*.ingest.de.sentry.io",
      ...extra,
    ],
    ["frame-src", "'self'", ...extra],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["object-src", "'none'"],
  ].map((parts) => parts.filter(Boolean).join(" "));

  const report = cspReportEndpoint();
  if (report) {
    directives.push(`report-uri ${report}`);
    directives.push("report-to csp-endpoint");
  }
  return directives.join("; ");
}

/** Value for the Report-To header that pairs with `report-to csp-endpoint`. */
export function reportToHeader(): string | null {
  const ep = cspReportEndpoint();
  if (!ep) return null;
  return JSON.stringify({
    group: "csp-endpoint",
    max_age: 10886400,
    endpoints: [{ url: ep }],
  });
}
