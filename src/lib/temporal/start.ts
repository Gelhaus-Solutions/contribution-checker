import "server-only";
import { randomUUID } from "node:crypto";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { prisma } from "@/lib/db";
import { getTemporalClient } from "./client";
import { TASK_QUEUE, workflowIds } from "./task-queue";
import { SA } from "./search-attributes";
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

/** Route a PR event into the entity tree: signal the author's contributorGate,
 * which starts/forwards to the per-PR prGate CHILD (so the Relationships tab
 * shows contributor → pr). Resolves the project from the repo and the author
 * from the webhook payload; for an unmanaged repo or an author we can't identify
 * we fall back to a top-level prGate so the event is still processed (and
 * IGNORED by decideForPR as before). */
export async function dispatchPullRequestEvent(
  repoId: string,
  prNumber: number,
  env: GithubEventEnvelope
): Promise<void> {
  const client = await getTemporalClient();
  const ghRepoId = Number(repoId);
  const authorGhId = (
    env.payload as { pull_request?: { user?: { id?: number } } } | null
  )?.pull_request?.user?.id;
  const repo = Number.isFinite(ghRepoId)
    ? await prisma.repo.findUnique({
        where: { ghRepoId },
        select: { projectId: true },
      })
    : null;

  if (repo && authorGhId != null) {
    await client.workflow.signalWithStart(WF.contributorGate, {
      workflowId: workflowIds.contributor(repo.projectId, authorGhId),
      taskQueue: TASK_QUEUE,
      signal: SIG.prEvent,
      signalArgs: [{ ghRepoId: repoId, prNumber, envelope: env }],
      args: [{ projectId: repo.projectId, authorGhId }],
      // Findable in the Temporal UI before the first task runs. Applies only
      // on the start leg; the workflow re-upserts on transitions.
      typedSearchAttributes: [
        { key: SA.ProjectId, value: repo.projectId },
        { key: SA.ContributorGhId, value: authorGhId },
      ],
    });
    return;
  }

  // Fallback: top-level prGate (no contributor parent). The triggering event
  // arrives via the signal, so the start args carry only the PR identity.
  await client.workflow.signalWithStart(WF.prGate, {
    workflowId: workflowIds.pullRequest(repoId, prNumber),
    taskQueue: TASK_QUEUE,
    signal: SIG.githubEvent,
    signalArgs: [env],
    args: [{ repoId, prNumber }],
    typedSearchAttributes: [
      { key: SA.RepoId, value: repoId },
      { key: SA.PrNumber, value: prNumber },
    ],
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
    typedSearchAttributes: [
      { key: SA.RepoId, value: repoId },
      { key: SA.PrNumber, value: prNumber },
    ],
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
    typedSearchAttributes: [
      { key: SA.ProjectId, value: projectId },
      { key: SA.ContributorGhId, value: authorGhId },
    ],
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
 * affected-PR count is not surfaced to the admin UI. The applicant's inbox +
 * email ride the entity's post-decision activity; when the applicant has no
 * GitHub identity (no entity to signal, and no PRs to fan out over) they are
 * sent inline here, best-effort. */
export async function dispatchContributorDecision(
  kind: ApplicationDecisionKind,
  applicationId: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  const who = await resolveApplicationContributor(applicationId);
  if (!who) {
    const { notifyApplicationDecision } = await import(
      "@/lib/applications/notify-decision"
    );
    await notifyApplicationDecision({
      kind,
      applicationId,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      revokeTarget:
        args.target === "DENIED" ||
        args.target === "SUBMITTED" ||
        args.target === "PENDING"
          ? args.target
          : undefined,
    }).catch((e) =>
      logger.warn(
        { err: e, applicationId, kind },
        "inline decision notification failed"
      )
    );
    return;
  }
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

/** Low-level: signal the project entity (start it if not running). Keyed by
 * projectId; the top of the project → contributor → pr tree. */
async function signalProject(
  projectId: string,
  signal: string,
  signalArg: unknown
): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.signalWithStart(WF.projectGate, {
    workflowId: workflowIds.project(projectId),
    taskQueue: TASK_QUEUE,
    signal,
    signalArgs: [signalArg],
    args: [{ projectId }],
    typedSearchAttributes: [{ key: SA.ProjectId, value: projectId }],
  });
}

/** Keepalive nudge from the ensureProjectGates schedule: bootstraps the entity
 * for a newly-active project, resurrects one that idle-retired, and wakes a
 * running one so elapsed sweep deadlines fire. */
export async function signalProjectSweepTick(projectId: string): Promise<void> {
  await signalProject(projectId, SIG.sweepTick, {});
}

/** Re-gate every tracked PR by an author in a project. Now a thin signal to the
 * projectGate entity, which runs the DB query and the reGate fan-out durably
 * and batched in activities (the old version looped signalWithStart per PR in
 * this request). A shared nonce coalesces duplicates at each prGate. */
export async function reGateAuthorPrs(args: {
  projectId: string;
  ghId?: number | null;
  ghLogin?: string | null;
  reason: string;
}): Promise<void> {
  if (args.ghId == null && !args.ghLogin) return;
  await signalProject(args.projectId, SIG.reGateAuthor, {
    ghId: args.ghId ?? null,
    ghLogin: args.ghLogin ?? null,
    reason: args.reason,
    nonce: randomUUID(),
  });
}

/** Re-gate every tracked PR in a project (config changes that affect all
 * authors, and the "re-evaluate all" admin action). Durable via projectGate. */
export async function reGateProjectPrs(args: {
  projectId: string;
  reason: string;
}): Promise<void> {
  await signalProject(args.projectId, SIG.reGateAll, {
    reason: args.reason,
    nonce: randomUUID(),
  });
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
  // The projectGate entity launches qualityBackfill as its CHILD (dedup on the
  // nonce while one is live), completing the project → backfill tree. The
  // child's deterministic id is reconstructable, so the signature is unchanged.
  await signalProject(input.projectId, SIG.runBackfill, {
    triggeredById: input.triggeredById,
    limit: input.limit,
    nonce,
  });
  const workflowId = workflowIds.qualityBackfill(input.projectId, nonce);
  logger.info({ workflowId }, "quality backfill dispatched via projectGate");
  return workflowId;
}

export type { QualityBackfillResult };
