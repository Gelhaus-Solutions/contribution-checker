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
<<<<<<< HEAD
 * Operator-configurable EXTRA domains, appended to the existing CSP's
 * resource directives. One env var, `CSP_EXTRA_DOMAINS`, space- or
 * comma-separated; supports wildcard hosts (e.g. `https://*.example.com`),
 * plain domains, and scheme tokens (`data:`, `blob:`). Read from process.env
 * directly so this stays edge-safe (middleware runs on the edge runtime and
 * can't import the Node env module).
 */
function extraDomains(): string[] {
  const raw = process.env.CSP_EXTRA_DOMAINS;
=======
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
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
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
<<<<<<< HEAD

  // Operator-added domains, appended to the resource directives so an allowed
  // domain works wherever the page needs it (connect/img/script/style/font/
  // frame/media/worker). `data:`/`blob:` are in connect-src because the Hexclave
  // SDK fetch()es data:/blob: URLs (e.g. avatar images on the account-settings
  // page); a Fetch is governed by connect-src, not img-src.
  const extra = extraDomains();
=======
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690

  // Each directive is an array of sources so operators can append extra origins
  // via env. `data:`/`blob:` are in connect-src because the Hexclave SDK fetch()es
  // data:/blob: URLs (e.g. avatar images on the account-settings page); a Fetch
  // is governed by connect-src, not img-src.
  const directives = [
<<<<<<< HEAD
    ["default-src", "'self'", ...extra],
=======
    ["default-src", "'self'", ...extraSources("CSP_DEFAULT_SRC")],
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
    [
      "img-src",
      "'self'",
      "https://avatars.githubusercontent.com",
      "data:",
      "blob:",
<<<<<<< HEAD
      ...extra,
    ],
    ["media-src", "'self'", "blob:", ...extra],
=======
      ...extraSources("CSP_IMG_SRC"),
    ],
    ["media-src", "'self'", "blob:", ...extraSources("CSP_MEDIA_SRC")],
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
    [
      "script-src",
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "blob:",
      "https://js.stripe.com",
<<<<<<< HEAD
      ...extra,
    ],
    ["worker-src", "'self'", "blob:", ...extra],
    ["style-src", "'self'", "'unsafe-inline'", ...extra],
    ["font-src", "'self'", "data:", ...extra],
=======
      ...extraSources("CSP_SCRIPT_SRC"),
    ],
    ["worker-src", "'self'", "blob:", ...extraSources("CSP_WORKER_SRC")],
    ["style-src", "'self'", "'unsafe-inline'", ...extraSources("CSP_STYLE_SRC")],
    ["font-src", "'self'", "data:", ...extraSources("CSP_FONT_SRC")],
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
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
<<<<<<< HEAD
      ...extra,
=======
      ...extraSources("CSP_CONNECT_SRC"),
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
    ],
    [
      "frame-src",
      "'self'",
      "https://js.stripe.com",
      "https://hooks.stripe.com",
<<<<<<< HEAD
      ...extra,
    ],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
=======
      ...extraSources("CSP_FRAME_SRC"),
    ],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'", ...extraSources("CSP_FORM_ACTION")],
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
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
