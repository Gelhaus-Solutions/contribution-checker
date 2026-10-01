import * as Sentry from "@sentry/nextjs";
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
    // Replay is recorded only around an error and with everything masked:
    // the public application form and the CLA page carry names, signatures
    // and free-text answers, none of which may leave the browser as clear
    // text (GDPR Art. 5(1)(c), Art. 32).
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
      maskAllInputs: true,
    }),
    Sentry.browserProfilingIntegration(),
    // Capture browser console.error/warn as Sentry events. Most React/Next
    // client-side runtime errors surface as console.error before any error
    // boundary sees them; without this, those never make it to Sentry.
    Sentry.captureConsoleIntegration({
      levels: ["error", "warn"],
    }),
  ],
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 0,
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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
