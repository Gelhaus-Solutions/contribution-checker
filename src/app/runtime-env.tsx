// Server Component. Reads runtime env in the runner container and writes a
// minimal allowlist onto `window.__ENV__` via an inline <script> in <head>,
// before any client bundle executes. Lets us ship a single Docker image and
// configure NEXT_PUBLIC_-style values per-deployment at runtime instead of
// inlining them at `next build` time.

const PUBLIC_KEYS = [
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
] as const;

export function RuntimeEnvScript() {
  const payload: Record<string, string> = {};
  for (const k of PUBLIC_KEYS) {
    const v =
      process.env[`NEXT_PUBLIC_${k}`] ?? process.env[k];
    if (v) payload[k] = v;
  }
  // Stringify safely: escape `</` so a malicious value can't close the script tag.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return (
    <script
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `window.__ENV__=${json};`,
      }}
    />
  );
}

export type PublicRuntimeEnv = Partial<Record<(typeof PUBLIC_KEYS)[number], string>>;

declare global {
  interface Window {
    __ENV__?: PublicRuntimeEnv;
  }
}
