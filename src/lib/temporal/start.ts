import "server-only";
import { randomUUID } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { prisma } from "@/lib/db";
import { getTemporalClient } from "./client";
import { TASK_QUEUE, workflowIds } from "./task-queue";
import { WF, SIG } from "./contracts";
import type {
  ApplicationDecisionKind,
  ClaCoverageChangedPayload,
  DecisionChangedPayload,
} from "./contracts";
import type {
  CiCheckPrInput,
  CiReconcileInput,
  GithubEventEnvelope,
  OutboundWebhookInput,
  QualityBackfillInput,
  QualityBackfillResult,
  ReGatePayload,
} from "./contracts";
import { logger } from "@/lib/logger";

/** Swallow "already started" so deterministic-id starts are idempotent: a
 * GitHub redelivery or an activity retry re-issuing the same start is a no-op. */
async function startIdempotent(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) return;
    throw e;
  }
}

/** Per-PR entity workflow (prGate): signal it if running, else start it. The
 * workflow id is stable per (repo, PR) so every event for a PR lands on one
 * execution. On a fresh start the triggering event arrives via the signal, so
 * the start args carry only the PR identity. */
export async function dispatchPullRequestEvent(
  repoId: string,
  prNumber: number,
  env: GithubEventEnvelope
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.signalWithStart(WF.prGate, {
    workflowId: workflowIds.pullRequest(repoId, prNumber),
    taskQueue: TASK_QUEUE,
    signal: SIG.githubEvent,
    signalArgs: [env],
    args: [{ repoId, prNumber }],
  });
}

/** Tell the per-PR gate to re-evaluate itself (no payload — the gate re-fetches
 * current state). signalWithStart so a PR with no live gate (e.g. between an
 * idle-completion and the next event) still re-converges. */
export async function signalPrReGate(
  repoId: string,
  prNumber: number,
  payload: ReGatePayload
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.signalWithStart(WF.prGate, {
    workflowId: workflowIds.pullRequest(repoId, prNumber),
    taskQueue: TASK_QUEUE,
    signal: SIG.reGate,
    signalArgs: [payload],
    args: [{ repoId, prNumber }],
  });
}

export async function dispatchMergeGroupEvent(
  repoId: string,
  headSha: string,
  payload: unknown
): Promise<void> {
  const client = await getTemporalClient();
  await startIdempotent(() =>
    client.workflow.start(WF.processMergeGroup, {
      workflowId: workflowIds.mergeGroup(repoId, headSha),
      taskQueue: TASK_QUEUE,
      args: [{ payload }],
      workflowIdReusePolicy:
        WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    })
  );
}

export async function dispatchPushEvent(
  repoId: string,
  ref: string,
  after: string,
  payload: unknown
): Promise<void> {
  const client = await getTemporalClient();
  await startIdempotent(() =>
    client.workflow.start(WF.processPush, {
      workflowId: workflowIds.push(repoId, ref, after),
      taskQueue: TASK_QUEUE,
      args: [{ payload }],
    })
  );
}

export async function dispatchInstallationEvent(
  installationId: number,
  deliveryId: string,
  kind: "installation" | "installation_repositories",
  payload: unknown
): Promise<void> {
  const client = await getTemporalClient();
  await startIdempotent(() =>
    client.workflow.start(WF.processInstallation, {
      workflowId: workflowIds.installation(installationId, deliveryId),
      taskQueue: TASK_QUEUE,
      args: [{ kind, payload }],
    })
  );
}

/** Low-level: signal the contributor entity (start it if not running). Keyed by
 * (projectId, authorGhId) so every signal for a contributor lands on one
 * execution that holds their timers. */
async function signalContributor(
  projectId: string,
  authorGhId: number,
  signal: string,
  signalArg: unknown
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.signalWithStart(WF.contributorGate, {
    workflowId: workflowIds.contributor(projectId, authorGhId),
    taskQueue: TASK_QUEUE,
    signal,
    signalArgs: [signalArg],
    args: [{ projectId, authorGhId }],
  });
}

/** Resolve an application to its (projectId, applicant ghId). Returns null when
 * the applicant has no GitHub identity yet (can't key a contributor entity). */
async function resolveApplicationContributor(
  applicationId: string
): Promise<{ projectId: string; ghId: number } | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { projectId: true, user: { select: { ghId: true } } },
  });
  if (!app || app.user.ghId == null) return null;
  return { projectId: app.projectId, ghId: app.user.ghId };
}

/** An application decision (approve/deny/revoke) → run the GitHub fan-out on the
 * contributor entity and (re)arm its cooldown timer. Replaces the old
 * dispatchApplicationDecision + startCooldownTimer pair. Fire-and-forget: the
 * affected-PR count is not surfaced to the admin UI. */
export async function dispatchContributorDecision(
  kind: ApplicationDecisionKind,
  applicationId: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  const who = await resolveApplicationContributor(applicationId);
  if (!who) return;
  const payload: DecisionChangedPayload = { kind, applicationId, args };
  await signalContributor(who.projectId, who.ghId, SIG.decisionChanged, payload);
}

/** A cooldown-setting action with no GitHub fan-out (allow-resubmit, or a revoke
 * that only changed the cooldown) → have the contributor entity re-read the
 * application's cooldown and (re)arm/clear its timer. */
export async function refreshContributorCooldown(
  applicationId: string
): Promise<void> {
  const who = await resolveApplicationContributor(applicationId);
  if (!who) return;
  await signalContributor(who.projectId, who.ghId, SIG.cooldownRefresh, {
    applicationId,
  });
}

/** A CLA-coverage change for one contributor → re-pass (gain) or re-gate (loss)
 * their CLA-gated PRs via the contributor entity. */
export async function dispatchClaCoverageChange(
  projectId: string,
  ghId: number,
  direction: "gain" | "loss",
  recheckAtIso?: string
): Promise<void> {
  const payload: ClaCoverageChangedPayload = { direction, recheckAtIso };
  await signalContributor(projectId, ghId, SIG.claCoverageChanged, payload);
}

/** DB-backed re-gate fan-out: signal `reGate` to every tracked PR by an author
 * in a project (by ghId and/or ghLogin), so each prGate re-evaluates itself.
 * signalWithStart means even a PR with no live gate (idle-completed) re-converges.
 * This replaces the label-spray and powers the manual-decision and corporate-CLA
 * re-gate fixes. A shared nonce coalesces duplicates at each prGate. */
export async function reGateAuthorPrs(args: {
  projectId: string;
  ghId?: number | null;
  ghLogin?: string | null;
  reason: string;
}): Promise<{ signaled: number }> {
  const authorOr: Array<{ authorGhId?: number; authorGhLogin?: string }> = [];
  if (args.ghId != null) authorOr.push({ authorGhId: args.ghId });
  if (args.ghLogin) authorOr.push({ authorGhLogin: args.ghLogin });
  if (authorOr.length === 0) return { signaled: 0 };

  const checks = await prisma.prCheck.findMany({
    where: {
      OR: authorOr,
      repo: {
        projectId: args.projectId,
        active: true,
        installationId: { not: null },
      },
    },
    select: { prNumber: true, repo: { select: { ghRepoId: true } } },
  });
  const nonce = randomUUID();
  let signaled = 0;
  for (const c of checks) {
    if (c.repo.ghRepoId == null) continue;
    await signalPrReGate(String(c.repo.ghRepoId), c.prNumber, {
      reason: args.reason,
      nonce,
    });
    signaled += 1;
  }
  return { signaled };
}

/** Re-gate every tracked PR in a project (used by config changes that affect all
 * authors, and the "re-evaluate all" admin action). */
export async function reGateProjectPrs(args: {
  projectId: string;
  reason: string;
}): Promise<{ signaled: number }> {
  const checks = await prisma.prCheck.findMany({
    where: {
      repo: {
        projectId: args.projectId,
        active: true,
        installationId: { not: null },
      },
    },
    select: { prNumber: true, repo: { select: { ghRepoId: true } } },
  });
  const nonce = randomUUID();
  let signaled = 0;
  for (const c of checks) {
    if (c.repo.ghRepoId == null) continue;
    await signalPrReGate(String(c.repo.ghRepoId), c.prNumber, {
      reason: args.reason,
      nonce,
    });
    signaled += 1;
  }
  return { signaled };
}

export type CiCoreResult = { status: number; json: unknown };

/** CI mode: start + await the workflow result so the Action gets its answer.
 * The caller builds a stable-enough workflow id (slug + PR + head sha). */
export async function runCiCheckPrWorkflow(
  workflowId: string,
  body: unknown,
  claims: unknown
): Promise<CiCoreResult> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start(WF.ciCheckPr, {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [{ body, claims } satisfies CiCheckPrInput],
    workflowIdReusePolicy:
      WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
  });
  return handle.result() as Promise<CiCoreResult>;
}

export async function runCiReconcileWorkflow(
  workflowId: string,
  body: unknown,
  claims: unknown
): Promise<CiCoreResult> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start(WF.ciReconcile, {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [{ body, claims } satisfies CiReconcileInput],
    workflowIdReusePolicy:
      WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
  });
  return handle.result() as Promise<CiCoreResult>;
}

/** Outbound webhook delivery: one durable workflow per (endpoint, event,
 * dedup-key). Idempotent on the deterministic id. */
export async function startOutboundWebhook(
  input: OutboundWebhookInput,
  deliveryKey: string
): Promise<void> {
  const client = await getTemporalClient();
  await startIdempotent(() =>
    client.workflow.start(WF.outboundWebhookDelivery, {
      workflowId: workflowIds.outboundWebhook(deliveryKey),
      taskQueue: TASK_QUEUE,
      args: [input],
      workflowIdReusePolicy:
        WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    })
  );
}

export async function startQualityBackfill(
  input: QualityBackfillInput,
  nonce: string
): Promise<string> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start(WF.qualityBackfill, {
    workflowId: workflowIds.qualityBackfill(input.projectId, nonce),
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  logger.info({ workflowId: handle.workflowId }, "quality backfill started");
  return handle.workflowId;
}

export type { QualityBackfillResult };
