/**
 * Shared Temporal contracts: workflow/signal names and the structural payload
 * types exchanged between the Next.js app (which starts/signals workflows) and
 * the worker (which runs them).
 *
 * This module must stay import-light: it is pulled into the deterministic
 * workflow bundle, so it may contain ONLY types and plain constants — no
 * prisma, no Octokit, no Node built-ins. Domain payloads are kept structural
 * (plain JSON) on purpose; the activities re-cast them to the rich handler
 * types on the worker side.
 */

/** Exported workflow function names. The client starts workflows by these
 * strings so workflow implementation modules never have to be bundled into the
 * Next.js server. Each must match an exported function in src/worker/workflows. */
export const WF = {
  processPullRequest: "processPullRequest",
  processMergeGroup: "processMergeGroup",
  processPush: "processPush",
  processInstallation: "processInstallation",
  ciCheckPr: "ciCheckPr",
  ciReconcile: "ciReconcile",
  applicationDecision: "applicationDecision",
  applicationCooldownTimer: "applicationCooldownTimer",
  claStalenessTimer: "claStalenessTimer",
  outboundWebhookDelivery: "outboundWebhookDelivery",
  qualityBackfill: "qualityBackfill",
  reconcileSweep: "reconcileSweep",
  claSweep: "claSweep",
  pruneProcessedDeliveries: "pruneProcessedDeliveries",
} as const;

/** Signal sent to the long-lived per-PR entity workflow when a new GitHub event
 * arrives for that PR. */
export const SIG = {
  githubEvent: "githubEvent",
} as const;

// --- payloads --------------------------------------------------------------

/** A raw, already-parsed GitHub webhook JSON body plus the routing metadata the
 * route extracted from headers. Kept as `unknown` body so the workflow never
 * inspects it — the activity casts to the rich handler type. */
export type GithubEventEnvelope = {
  eventName: string;
  deliveryId: string;
  /** The parsed webhook JSON. Opaque to the workflow. */
  payload: unknown;
};

export type ProcessPullRequestInput = {
  repoId: string;
  prNumber: number;
  /** The event that triggered this run (the signalWithStart start arg). */
  first: GithubEventEnvelope;
  /** Events carried over from a prior run via Continue-As-New. Absent on the
   * initial signalWithStart. */
  pending?: GithubEventEnvelope[];
};

export type ProcessMergeGroupInput = { payload: unknown };
export type ProcessPushInput = { payload: unknown };
export type ProcessInstallationInput = {
  /** "installation" or "installation_repositories" */
  kind: "installation" | "installation_repositories";
  payload: unknown;
};

export type ApplicationDecisionKind = "approved" | "denied" | "revoked";

export type ApplicationDecisionInput = {
  kind: ApplicationDecisionKind;
  applicationId: string;
  /** Free-form context the post-decision activity needs (reason, decider, etc.).
   * Opaque to the workflow; the activity casts it. */
  args: Record<string, unknown>;
};

export type ApplicationDecisionResult = {
  affectedPrs: number;
};

export type CooldownTimerInput = {
  applicationId: string;
  /** ISO timestamp the cooldown elapses. */
  cooldownUntilIso: string;
};

export type ClaStalenessTimerInput = {
  projectId: string;
  ghId: string;
  /** ISO timestamp to re-check at. */
  recheckAtIso: string;
};

export type OutboundWebhookInput = {
  projectId: string;
  endpointId: string;
  kind: "generic" | "discord";
  event: string;
  /** Pre-formatted request body (generic JSON or Discord embed). */
  body: string;
  url: string;
};

export type OutboundAttemptResult = {
  ok: boolean;
  status: number | null;
  responseBody: string | null;
  /** Set when the URL failed SSRF preflight; the delivery is non-retryable. */
  blocked: boolean;
};

/** CI inputs carry the validated body plus the verified OIDC claims (token
 * verification stays at the HTTP edge; the workflow/activity just compute). Kept
 * structural/opaque here so the workflow bundle stays import-light. */
export type CiCheckPrInput = { body: unknown; claims: unknown };
export type CiReconcileInput = { body: unknown; claims: unknown };
export type CiCoreResult = { status: number; json: unknown };

export type QualityBackfillInput = {
  projectId: string;
  triggeredById: string | null;
  /** Cap from the admin action (defaults applied on the worker side). */
  limit: number;
};

export type QualityBackfillResult = {
  scored: number;
  failed: number;
};

/** Backoff schedule (ms) for outbound webhook delivery, preserved from the
 * legacy in-process retry worker: 1m, 5m, 30m after the first attempt. */
export const OUTBOUND_RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 30 * 60_000];
