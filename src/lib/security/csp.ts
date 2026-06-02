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
  // the backend directly, so its origin must be allowed in connect-src.
  const stackOrigin = originOf(process.env.STACK_API_URL);
  const connectSrc = [
    "'self'",
    "https://*.sentry.io",
    "https://*.ingest.sentry.io",
    "https://*.ingest.us.sentry.io",
    "https://*.ingest.de.sentry.io",
    stackOrigin,
  ]
    .filter(Boolean)
    .join(" ");

  const directives = [
    "default-src 'self'",
    "img-src 'self' https://avatars.githubusercontent.com data: blob:",
    "media-src 'self' blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];

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
