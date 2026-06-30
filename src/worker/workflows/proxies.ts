import { proxyActivities } from "@temporalio/workflow";
// Type-only import: the activity implementations (prisma, Octokit, Vault, …)
// are NEVER bundled into the deterministic workflow code. proxyActivities only
// needs the *types* to give us a typed, name-routed proxy.
import type * as activities from "../activities";

/**
 * Default proxy for GitHub/DB side-effect activities. Generous start-to-close
 * (a PR event runs the whole decision + label + check + quality pipeline) with
 * SDK-managed retries on transient failures.
 */
export const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 8,
  },
});

/**
 * Proxy for the single outbound-webhook POST attempt. The workflow owns the
 * retry/backoff schedule, so the activity itself must NOT be retried by the SDK
 * (maximumAttempts: 1) — it returns a structured result instead of throwing on
 * HTTP failure.
 */
export const outboundActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});
