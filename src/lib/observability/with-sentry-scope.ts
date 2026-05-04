import * as Sentry from "@sentry/nextjs";

type Attrs = Record<string, string | number | boolean | undefined | null>;

function compact(attrs: Attrs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Run `fn` inside a Sentry scope with `attrs` attached as scope attributes.
 * Spans, metrics, logs, and errors emitted while the scope is active inherit
 * those attributes. Use for request-shaped facets (github.repo, ci.run_id).
 */
export function withSentryScope<T>(
  attrs: Attrs,
  fn: () => Promise<T>,
): Promise<T> {
  return Sentry.withScope((scope) => {
    scope.setAttributes(compact(attrs));
    return fn();
  });
}
