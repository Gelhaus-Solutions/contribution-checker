import * as Sentry from "@sentry/nextjs";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { scrubSensitive } from "@/lib/observability/scrub";

const environment =
  process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment,
  integrations: [
    nodeProfilingIntegration(),
    // Forward console.error/warn/log/info as Sentry events. This catches the
    // framework-level "⨯ [Error: x]" lines that Next.js writes directly to
    // stderr (e.g. stale server-action IDs from older deployments), which our
    // logger wrapper can't intercept on its own.
    Sentry.captureConsoleIntegration({
      levels: ["error", "warn"],
    }),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  sendDefaultPii: true,
  enableLogs: true,
  // Ship console.log/info/warn/error as Sentry log entries too, so structured
  // logs and framework console output share one timeline.
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
  "service.runtime": process.env.NEXT_RUNTIME ?? "nodejs",
  "service.version":
    process.env.npm_package_version ?? process.env.APP_VERSION ?? "unknown",
  "deploy.commit":
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
  "deploy.env": environment,
  "node.version": process.version,
});
