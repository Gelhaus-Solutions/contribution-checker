import { proxyActivities, proxyLocalActivities } from "@temporalio/workflow";
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

/**
 * Local-activity proxy for tiny, idempotent, side-effect-free reads (currently
 * just readApplicationCooldown). Runs in-process inside the workflow task: no
 * per-call server round-trip and far fewer history events than a regular
 * activity, which directly relieves Continue-As-New pressure. MUST stay short
 * and idempotent: a worker restart mid-run replays the whole workflow task,
 * and local activities have no independent execution visibility in the UI.
 * Anything that writes or notifies stays on `acts`.
 */
export const localActs = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  // Retry quick DB blips locally; past the threshold the SDK converts to a
  // timer-backed retry so a longer outage doesn't spin the workflow task.
  localRetryThreshold: "1 minute",
  retry: {
    initialInterval: "200ms",
    backoffCoefficient: 2,
    maximumInterval: "2 seconds",
    maximumAttempts: 5,
  },
});
