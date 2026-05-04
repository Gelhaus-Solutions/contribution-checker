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

// One-shot transport diagnostic on boot. If this message lands in Sentry,
// the DSN/network/transport is working end-to-end; the absence of other
// events then means nothing in the app has been captured yet (no errors
// raised, no user traffic with tracing, etc.). If it does NOT land, the
// transport is silently failing — most commonly DSN typo, a wrong project
// key, or egress blocked by the host's network. Remove this block once
// you've verified arrival.
if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
  const eventId = Sentry.captureMessage(
    `[boot] contribution-checker server started @ ${new Date().toISOString()}`,
    "info",
  );
  console.info("[sentry.server] boot smoke eventId =", eventId);
  void Sentry.flush(2000).then((ok) =>
    console.info("[sentry.server] boot smoke flushed =", ok),
  );
}
