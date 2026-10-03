import * as Sentry from "@sentry/nextjs";
import { readReplayChoice, startReplay } from "@/lib/observability/replay-consent";
import { scrubSensitive } from "@/lib/observability/scrub";

// Read from the runtime-injected window.__ENV__ first (set by the
// RuntimeEnvScript in the root layout from server-side process.env at request
// time), then fall back to build-time NEXT_PUBLIC_* if any. This lets a
// single Docker image be deployed with per-environment Sentry config.
const runtimeEnv =
  typeof window !== "undefined" ? window.__ENV__ ?? {} : {};

const dsn =
  runtimeEnv.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN ?? undefined;
const environment =
  runtimeEnv.SENTRY_ENVIRONMENT ??
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
  process.env.NODE_ENV;

Sentry.init({
  dsn,
  environment,
  integrations: [
    // No replay here: it is added by startReplay() below, and only for a
    // visitor who allowed it (lib/observability/replay-consent.ts).
    Sentry.browserProfilingIntegration(),
    // Capture browser console.error/warn as Sentry events. Most React/Next
    // client-side runtime errors surface as console.error before any error
    // boundary sees them; without this, those never make it to Sentry.
    Sentry.captureConsoleIntegration({
      levels: ["error", "warn"],
    }),
  ],
  tracesSampleRate: 1.0,
  // Apply once replay is added: a visitor who allowed recording is recorded
  // whole, unmasked, from the page they allowed it on (the operator's
  // decisions, 2026-10-02 and 2026-10-04).
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  profilesSampleRate: 1.0,
  // No IP address, cookies or request bodies: the internal user id set in
  // sentry-user-client.tsx is enough to find an affected account.
  sendDefaultPii: false,
  enableLogs: true,
  _experiments: {
    enableLogs: true,
  },
  beforeSend(event) {
    return scrubSensitive(event);
  },
  beforeBreadcrumb(crumb) {
    return scrubSensitive(crumb);
  },
});

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": "browser",
  "deploy.env": environment ?? "unknown",
});

// A yes given on an earlier page or visit. A first-time visitor is asked by
// <ReplayConsent> in the root layout, and nothing is recorded until they answer.
if (dsn && readReplayChoice() === "granted") startReplay();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
