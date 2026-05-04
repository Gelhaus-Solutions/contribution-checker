import * as Sentry from "@sentry/nextjs";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  sendDefaultPii: true,
  enableLogs: true,
});

console.info(
  "[sentry.server] init",
  process.env.SENTRY_DSN
    ? `dsn=set (len=${process.env.SENTRY_DSN.length}) env=${process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV}`
    : "DSN MISSING — SDK is no-op",
);

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": process.env.NEXT_RUNTIME ?? "nodejs",
  "deploy.commit":
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
  "deploy.env": process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
});
