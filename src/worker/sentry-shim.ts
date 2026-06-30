/**
 * Worker-only shim for `@sentry/nextjs`. esbuild aliases all `@sentry/nextjs`
 * imports to this file when bundling the worker (see scripts/build-worker.mjs).
 *
 * Why: with node_modules kept external in an ESM bundle, Node's CJS->ESM
 * namespace interop drops `@sentry/nextjs`'s exports — `import * as Sentry`
 * yields an empty namespace, so every `Sentry.metrics` / `Sentry.capture
 * Exception` call in the app's shared libs crashes the worker. A runtime
 * `require()` of the package returns the full CommonJS object intact, so we
 * re-export the APIs the worker actually uses from that.
 *
 * `_require` (createRequire) is a runtime call, so esbuild does not rewrite it
 * through the alias — it loads the real package, not this shim.
 */
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S: Record<string, any> = _require("@sentry/nextjs");

const noopMetrics = {
  count() {},
  distribution() {},
  gauge() {},
  set() {},
  timing() {},
};

// Bind the real implementations (or safe no-ops) so the named-export shape the
// app's `import * as Sentry` expects is fully populated.
export const captureException = (...args: unknown[]) =>
  S.captureException?.(...args);
export const captureMessage = (...args: unknown[]) =>
  S.captureMessage?.(...args);
export const getCurrentScope = () => S.getCurrentScope?.();
export const getGlobalScope = () => S.getGlobalScope?.();
export const withScope = (...args: unknown[]) => S.withScope?.(...args);
export const setUser = (...args: unknown[]) => S.setUser?.(...args);
export const setContext = (...args: unknown[]) => S.setContext?.(...args);
export const setTag = (...args: unknown[]) => S.setTag?.(...args);
export const addBreadcrumb = (...args: unknown[]) => S.addBreadcrumb?.(...args);
export const init = (...args: unknown[]) => S.init?.(...args);
export const logger = S.logger;
export const metrics = S.metrics ?? noopMetrics;

export default S;
