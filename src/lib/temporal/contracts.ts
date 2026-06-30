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
  prGate: "prGate",
  contributorGate: "contributorGate",
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

/** Signals delivered to entity workflows. `githubEvent` carries a raw GitHub
 * webhook envelope to the per-PR gate; `reGate` is a parent gate telling a child
 * PR to re-evaluate itself (no payload — the gate re-fetches current state). */
export const SIG = {
  githubEvent: "githubEvent",
  reGate: "reGate",
  // contributorGate signals:
  decisionChanged: "decisionChanged",
  claCoverageChanged: "claCoverageChanged",
  cooldownRefresh: "cooldownRefresh",
  claStalenessArmed: "claStalenessArmed",
} as const;

/** Payload for the `reGate` signal. `reason` is for observability; `nonce`
 * coalesces a fan-out so a PR re-converges once per distinct re-gate even if the
 * fast (parent-signal) and completeness (projectReGate) paths both reach it. */
export type ReGatePayload = { reason?: string; nonce?: string };

/** An application decision (approve/deny/revoke) reached the contributor: run the
 * GitHub fan-out, then re-read the application's cooldown to (re)arm the timer. */
export type DecisionChangedPayload = {
  kind: ApplicationDecisionKind;
  applicationId: string;
  args: Record<string, unknown>;
};

/** CLA coverage for the contributor changed: gained (signed/waived/roster-added)
 * → re-pass gated PRs; lost (revoked/version-bump) → re-gate approved PRs. */
export type ClaCoverageChangedPayload = {
  direction: "gain" | "loss";
  /** Set on a version bump that requires re-signing, so the timer can re-arm. */
  recheckAtIso?: string;
};

/** A cooldown-setting action (deny/revoke/allow-resubmit) ran with no GitHub
 * fan-out of its own; the gate just re-reads the application's cooldown. */
export type CooldownRefreshPayload = { applicationId: string };

export type ClaStalenessArmedPayload = { atIso: string };

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

/** Per-PR entity workflow input. `repoId` is the GitHub repo id (as a string,
 * matching the `pr:{repoId}:{prNumber}` workflow id and decideForPR's ghRepoId).
 * On a fresh signalWithStart the triggering event arrives via the `githubEvent`
 * signal, so `pending` is empty; Continue-As-New carries any unprocessed events
 * and a not-yet-applied re-gate forward. */
export type PrGateInput = {
  repoId: string;
  prNumber: number;
  /** GitHub events carried over from a prior run via Continue-As-New. */
  pending?: GithubEventEnvelope[];
  /** A re-gate request carried over (received but not yet applied) at CAN. */
  pendingReGate?: ReGatePayload | null;
  /** Last applied re-gate nonce, carried across CAN to coalesce duplicates. */
  lastNonce?: string | null;
};

/** A queued unit of fan-out work the contributorGate drains. Mirrors the
 * state-change signals; kept structural so it survives Continue-As-New. */
export type ContributorTask =
  | { type: "decision"; kind: ApplicationDecisionKind; applicationId: string; args: Record<string, unknown> }
  | { type: "cla"; direction: "gain" | "loss" }
  | { type: "cooldownRefresh"; applicationId: string };

/** Per-contributor entity workflow input, keyed by (projectId, authorGhId). Holds
 * the contributor's durable cooldown + CLA-staleness timers and runs the
 * application/CLA fan-out. `pending*` / `cooldown` / `staleness` are carried
 * across Continue-As-New so timers and unprocessed work are never lost. */
export type ContributorGateInput = {
  projectId: string;
  authorGhId: number;
  pendingTasks?: ContributorTask[];
  /** Armed cooldown: the application whose cooldown elapses at `deadlineMs`. */
  cooldown?: { applicationId: string; deadlineMs: number } | null;
  /** Armed CLA-staleness re-check at `deadlineMs` (project-scoped). */
  staleness?: { deadlineMs: number } | null;
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
