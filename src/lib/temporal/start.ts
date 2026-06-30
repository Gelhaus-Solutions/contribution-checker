import "server-only";
import { randomUUID } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { getTemporalClient } from "./client";
import { TASK_QUEUE, workflowIds } from "./task-queue";
import { WF, SIG } from "./contracts";
import type {
  ApplicationDecisionInput,
  ApplicationDecisionResult,
  CiCheckPrInput,
  CiReconcileInput,
  CooldownTimerInput,
  ClaStalenessTimerInput,
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

/** Admin decision: start + await so the dashboard shows the final outcome. The
 * nonce makes each click a fresh execution (decisions are not idempotent across
 * distinct admin actions). */
export async function runApplicationDecisionWorkflow(
  input: ApplicationDecisionInput,
  nonce: string
): Promise<ApplicationDecisionResult> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start(WF.applicationDecision, {
    workflowId: workflowIds.applicationDecision(
      input.applicationId,
      input.kind,
      nonce
    ),
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  return handle.result() as Promise<ApplicationDecisionResult>;
}

/** Convenience: start + await an application-decision fan-out with a fresh
 * nonce. Drop-in replacement for the old inline onApplication* calls in the
 * admin server actions. */
export async function dispatchApplicationDecision(
  kind: ApplicationDecisionInput["kind"],
  applicationId: string,
  args: Record<string, unknown> = {}
): Promise<ApplicationDecisionResult> {
  return runApplicationDecisionWorkflow(
    { kind, applicationId, args },
    randomUUID()
  );
}

/** Durable cooldown timer: one per application; replacing an existing one (new
 * denial) terminates the prior and starts fresh. */
export async function startCooldownTimer(
  input: CooldownTimerInput
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.start(WF.applicationCooldownTimer, {
    workflowId: workflowIds.applicationCooldown(input.applicationId),
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdReusePolicy:
      WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING,
  });
}

export async function startClaStalenessTimer(
  input: ClaStalenessTimerInput
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.start(WF.claStalenessTimer, {
    workflowId: workflowIds.claStaleness(input.projectId, input.ghId),
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowIdReusePolicy:
      WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING,
  });
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
