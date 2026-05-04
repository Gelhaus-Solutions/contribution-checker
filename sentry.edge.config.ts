import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
  enableLogs: true,
  debug: process.env.NODE_ENV !== "production",
});

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": "edge",
  "deploy.commit":
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
  "deploy.env": process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
});
