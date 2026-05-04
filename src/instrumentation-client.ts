import * as Sentry from "@sentry/nextjs";

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
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
      maskAllInputs: false,
    }),
    Sentry.browserProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  profilesSampleRate: 1.0,
  sendDefaultPii: true,
  enableLogs: true,
});

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": "browser",
  "deploy.env": environment ?? "unknown",
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
