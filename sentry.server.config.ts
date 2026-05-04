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
  debug: process.env.NODE_ENV !== "production",
});

if (!process.env.SENTRY_DSN) {
  console.warn("[sentry.server.config] SENTRY_DSN is not set — SDK is no-op");
}

Sentry.getGlobalScope().setAttributes({
  "service.name": "contribution-checker",
  "service.runtime": process.env.NEXT_RUNTIME ?? "nodejs",
  "deploy.commit":
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
  "deploy.env": process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
});
