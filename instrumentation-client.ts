import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
    Sentry.browserProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  profilesSampleRate: 1.0,
  sendDefaultPii: true,
  enableLogs: true,
  debug: process.env.NODE_ENV !== "production",
});

if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
  console.warn(
    "[instrumentation-client] NEXT_PUBLIC_SENTRY_DSN is not set — browser SDK is no-op",
  );
}

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": "browser",
  "deploy.env":
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.NODE_ENV ??
    "unknown",
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
