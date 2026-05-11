import * as Sentry from "@sentry/nextjs";
import { scrubSensitive } from "@/lib/observability/scrub";

const environment =
  process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment,
  integrations: [
    Sentry.captureConsoleIntegration({
      levels: ["error", "warn"],
    }),
  ],
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
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
  "service.runtime": "edge",
  "deploy.commit":
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
  "deploy.env": environment,
});
