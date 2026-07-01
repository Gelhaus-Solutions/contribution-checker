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
  projectGate: "projectGate",
  ensureProjectGates: "ensureProjectGates",
  processMergeGroup: "processMergeGroup",
  processPush: "processPush",
  processInstallation: "processInstallation",
  ciCheckPr: "ciCheckPr",
  ciReconcile: "ciReconcile",
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
  prEvent: "prEvent",
  prChildCompleted: "prChildCompleted",
  decisionChanged: "decisionChanged",
  claCoverageChanged: "claCoverageChanged",
  cooldownRefresh: "cooldownRefresh",
  claStalenessArmed: "claStalenessArmed",
  // projectGate signals:
  reGateAll: "reGateAll",
  reGateAuthor: "reGateAuthor",
  configChanged: "configChanged",
  runBackfill: "runBackfill",
  sweepTick: "sweepTick",
} as const;

/** Query names for reading an entity workflow's durable state (ops/debugging).
 * Query handlers MUST be side-effect free: they only read closure state, never
 * mutate it, never call activities or timers. */
export const QRY = {
  prGateState: "prGateState",
  contributorGateState: "contributorGateState",
  projectGateState: "projectGateState",
} as const;

/** Temporal patch ids (workflow versioning via patched()/deprecatePatch).
 * Central registry so parallel changes don't collide and the deprecation
 * lifecycle is tracked in one place. Never rename a shipped id; retire an id
 * only after every run that could replay its old branch has drained. */
export const PATCHES = {
  prGateCanSuggested: "pr-gate-can-suggested-202607",
  contributorGateCanSuggested: "contributor-gate-can-suggested-202607",
  contributorGateCooldownLocal: "contributor-gate-cooldown-local-activity-202607",
  prGateSearchAttrs: "pr-gate-search-attrs-202607",
  contributorGateSearchAttrs: "contributor-gate-search-attrs-202607",
} as const;

/** A GitHub PR event routed to the contributor entity, which forwards it to (or
 * starts) the right prGate CHILD. Carrying the routing fields structurally keeps
 * the workflow from inspecting the opaque webhook payload. */
export type ContributorPrEvent = {
  /** GitHub repo id (string), the prGate child's `pr:{ghRepoId}:{prNumber}` id. */
  ghRepoId: string;
  prNumber: number;
  envelope: GithubEventEnvelope;
};

/** A prGate child telling its contributor parent it has completed (terminal
 * close or idle), so the parent drops it from its live-children set. */
export type PrChildCompletedPayload = { childWorkflowId: string };

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

/** Per-PR entity workflow input. `repoId` is the GitHub repo id (as a string,
 * matching the `pr:{repoId}:{prNumber}` workflow id and decideForPR's ghRepoId).
 * On a fresh signalWithStart the triggering event arrives via the `githubEvent`
 * signal, so `pending` is empty; Continue-As-New carries any unprocessed events
 * and a not-yet-applied re-gate forward. */
export type PrGateInput = {
  repoId: string;
  prNumber: number;
  /** The triggering event when started as a contributorGate CHILD (startChild
   * passes args, not a signal). Absent when started top-level by signalWithStart
   * (the event then arrives via the `githubEvent` signal). */
  first?: GithubEventEnvelope;
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
  | { type: "prEvent"; ghRepoId: string; prNumber: number; envelope: GithubEventEnvelope }
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
  /** Live prGate child workflow ids, carried across Continue-As-New. The gate
   * stays alive while any child is live and completes only once all report done
   * (so an ABANDON child is never orphaned by the parent idling out). */
  liveChildren?: string[];
};

/** Re-gate every tracked PR in the project. `reason` is for observability;
 * `nonce` is shared across the whole fan-out so each prGate coalesces
 * duplicates (fast parent-signal path vs this completeness path). */
export type ProjectReGateAllPayload = { reason: string; nonce: string };

/** Re-gate one author's tracked PRs in the project (manual decision edits,
 * corporate-CLA roster changes reaching an author with no user row, etc.). */
export type ProjectReGateAuthorPayload = {
  ghId?: number | null;
  ghLogin?: string | null;
  reason: string;
  nonce: string;
};

/** A gate-affecting config change: behaves like reGateAll but kept a distinct
 * signal so the source of the re-gate is observable in workflow history. */
export type ProjectConfigChangedPayload = { reason: string; nonce: string };

/** Admin-triggered quality backfill; the project entity launches the
 * qualityBackfill CHILD (dedup on nonce while one is live). */
export type ProjectRunBackfillPayload = {
  triggeredById: string | null;
  limit: number;
  nonce: string;
};

/** Global keepalive tick: wakes the entity so elapsed sweep deadlines fire and
 * a newly-active project bootstraps. Carries nothing; signalWithStart is the
 * point. */
export type ProjectSweepTickPayload = { reason?: string };

/** A queued unit of project-tier fan-out work the projectGate drains. Kept
 * structural so it survives Continue-As-New. */
export type ProjectTask =
  | { type: "reGateAll"; reason: string; nonce: string }
  | {
      type: "reGateAuthor";
      ghId: number | null;
      ghLogin: string | null;
      reason: string;
      nonce: string;
    }
  | { type: "runBackfill"; triggeredById: string | null; limit: number; nonce: string };

/** Per-project entity workflow input, keyed by projectId: the top of the
 * project → contributor → pr tree. Owns the durable per-project reconcile and
 * CLA sweep timers (replacing the global cron sweeps) and the batched re-gate
 * fan-out. Deadlines + queue + live children are carried across CAN. */
export type ProjectGateInput = {
  projectId: string;
  pendingTasks?: ProjectTask[];
  /** Next reconcile sweep deadline (epoch ms). Undefined/null = arm on start. */
  reconcileDeadlineMs?: number | null;
  /** Next CLA sweep deadline (epoch ms). Null = CLA sweeps disabled. */
  claDeadlineMs?: number | null;
};

/** Per-project sweep cadences, replacing the global 10-minute reconcile cron
 * and hourly CLA cron. The first arm is offset by a stable per-project jitter
 * so entities don't all fire at the same instant. */
export const PROJECT_RECONCILE_INTERVAL_MS = 10 * 60_000;
export const PROJECT_CLA_SWEEP_INTERVAL_MS = 60 * 60_000;

// --- query return types ------------------------------------------------------

/** prGate durable state, exposed via QRY.prGateState. Mirrors the workflow's
 * in-closure variables; `processed` resets on Continue-As-New. */
export type PrGateState = {
  repoId: string;
  prNumber: number;
  /** GitHub events queued but not yet converged. */
  pendingEvents: number;
  /** A re-gate received but not yet applied (null when none pending). */
  pendingReGate: ReGatePayload | null;
  /** Last applied re-gate nonce (dedupe key), null if never re-gated. */
  lastNonce: string | null;
  /** Terminal close (merge/human close) reached; the run is completing. */
  terminal: boolean;
  /** Events converged so far in THIS run. */
  processed: number;
};

/** contributorGate durable state, exposed via QRY.contributorGateState. */
export type ContributorGateState = {
  projectId: string;
  authorGhId: number;
  /** Queued tasks not yet drained. */
  queuedTasks: number;
  /** Queued task kinds, in order, for at-a-glance triage. */
  queuedKinds: ContributorTask["type"][];
  /** Live prGate child workflow ids. */
  liveChildren: string[];
  /** Armed cooldown, or null. `deadlineMs` is epoch ms. */
  cooldown: { applicationId: string; deadlineMs: number } | null;
  /** Armed CLA-staleness re-check, or null. */
  staleness: { deadlineMs: number } | null;
  /** Tasks drained so far in THIS run. */
  processed: number;
};

/** projectGate durable state, exposed via QRY.projectGateState. */
export type ProjectGateState = {
  projectId: string;
  /** Queued project-tier tasks not yet drained. */
  queuedTasks: number;
  /** Queued task kinds, in order. */
  queuedKinds: ProjectTask["type"][];
  /** Next reconcile sweep deadline (epoch ms), null when not armed. */
  reconcileDeadlineMs: number | null;
  /** Next CLA sweep deadline (epoch ms), null when CLA sweeps are off. */
  claDeadlineMs: number | null;
  /** Tasks drained so far in THIS run. */
  processed: number;
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
