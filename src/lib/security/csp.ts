/**
 * Content-Security-Policy built at RUNTIME (in middleware), not baked into the
 * build manifest by next.config's headers(). The connect-src must include the
 * operator's Hexclave backend (STACK_API_URL), which is only known at container
 * runtime in our generic CI-built image — so it can't be set at `next build`.
 *
 * Edge-safe: only string building + process.env reads, no Node/Hexclave/Vault.
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
 * Operator-configurable EXTRA CSP sources for a directive, read from an env var
 * (space- or comma-separated). Supports wildcard hosts (e.g.
 * `https://*.example.com`), plain domains, and scheme tokens (`data:`, `blob:`).
 * Read from process.env directly so this stays edge-safe (middleware runs on the
 * edge runtime and can't import the Node env module).
 *
 * Recognized vars (appended to the matching directive's defaults):
 *   CSP_DEFAULT_SRC  CSP_CONNECT_SRC  CSP_IMG_SRC  CSP_SCRIPT_SRC
 *   CSP_STYLE_SRC    CSP_FONT_SRC     CSP_FRAME_SRC  CSP_MEDIA_SRC
 *   CSP_WORKER_SRC   CSP_FORM_ACTION
 */
function extraSources(envName: string): string[] {
  const raw = process.env[envName];
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
  // The browser-side Hexclave SDK (mounted app-wide via <StackProvider>) calls
  // the backend directly, so its origin must be allowed in connect-src. The SDK
  // also bundles Stripe (Hexclave billing), which loads js.stripe.com and talks
  // to api.stripe.com / renders Stripe iframes, so those hosts are allowed too.
  const stackOrigin = originOf(process.env.STACK_API_URL);

  // Each directive is an array of sources so operators can append extra origins
  // via env. `data:`/`blob:` are in connect-src because the Hexclave SDK fetch()es
  // data:/blob: URLs (e.g. avatar images on the account-settings page); a Fetch
  // is governed by connect-src, not img-src.
  const directives = [
    ["default-src", "'self'", ...extraSources("CSP_DEFAULT_SRC")],
    [
      "img-src",
      "'self'",
      "https://avatars.githubusercontent.com",
      "data:",
      "blob:",
      ...extraSources("CSP_IMG_SRC"),
    ],
    ["media-src", "'self'", "blob:", ...extraSources("CSP_MEDIA_SRC")],
    [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "blob:",
      "https://js.stripe.com",
      ...extraSources("CSP_SCRIPT_SRC"),
    ],
    ["worker-src", "'self'", "blob:", ...extraSources("CSP_WORKER_SRC")],
    ["style-src", "'self'", "'unsafe-inline'", ...extraSources("CSP_STYLE_SRC")],
    ["font-src", "'self'", "data:", ...extraSources("CSP_FONT_SRC")],
    [
      "connect-src",
      "'self'",
      "data:",
      "blob:",
      "https://*.sentry.io",
      "https://*.ingest.sentry.io",
      "https://*.ingest.us.sentry.io",
      "https://*.ingest.de.sentry.io",
      "https://api.stripe.com",
      stackOrigin,
      ...extraSources("CSP_CONNECT_SRC"),
    ],
    [
      "frame-src",
      "'self'",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
      ...extraSources("CSP_FRAME_SRC"),
    ],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'", ...extraSources("CSP_FORM_ACTION")],
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
