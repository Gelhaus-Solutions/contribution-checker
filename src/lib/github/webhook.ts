import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import * as Sentry from "@sentry/nextjs";
import { decideForPR, type PrDecision } from "@/lib/applications/decide-pr";
import { buildDecisionMessage } from "@/lib/applications/decision-message";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import {
  closePullRequest,
  ensureLabel,
  removeLabelIfPresent,
  reopenPullRequest,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";
import { publishDecisionCheck } from "@/lib/github/check-run";
import { runQualityForPrCheck } from "@/lib/quality/run";

type WebhookPayload = {
  action?: string;
  installation?: { id: number };
  repository?: {
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
  };
  pull_request?: {
    number: number;
    node_id: string;
    state: string;
    user: { login: string; id: number; type: string };
    head?: { sha: string };
    title?: string;
    body?: string | null;
  };
  label?: { name: string };
  repositories?: Array<{ id: number; full_name: string }>;
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
};

async function attachInstallationToManualRepos(args: {
  installationId: number;
  repos: Array<{ id: number; full_name: string }>;
}) {
  for (const r of args.repos) {
    await prisma.repo
      .updateMany({
        where: { fullName: r.full_name, installationId: null },
        data: { ghRepoId: r.id, installationId: args.installationId, active: true },
      })
      .catch((e) =>
        logger.warn(
          { err: e, fullName: r.full_name },
          "linking manual repo to installation failed"
        )
      );
  }
}

type ProjectForSideEffects = {
  id: string;
  slug: string;
  name: string;
  checksEnabled: boolean;
  qualityEnabled: boolean;
  qualityConfig: string;
  qualityCommentMin: number;
  prTemplateHoneypots: string;
  trackWhenDisabled: boolean;
  checkerEnabled: boolean;
};

/**
 * Publish the Check Run and run quality scoring after a decision has been
 * applied (close/comment/label already done). Both paths are best-effort —
 * a failure here must not block the webhook response.
 */
async function postDecisionSideEffects(args: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  prCheckId: string | null;
  project: ProjectForSideEffects;
  decision: PrDecision;
  applyUrl: string;
}): Promise<void> {
  const { decision, project } = args;
  if (decision.status === "IGNORED") return;

  // Check Run (App-mode publishing). Skipped automatically when checks are
  // disabled or installation lacks checks:write.
  await publishDecisionCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    prCheckId: args.prCheckId,
    headSha: args.headSha,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      checksEnabled: project.checksEnabled,
    },
    decision,
    applyUrl: args.applyUrl,
  }).catch((e) =>
    logger.warn(
      { err: e, prCheckId: args.prCheckId },
      "publishDecisionCheck failed"
    )
  );

  // Quality scoring runs only when there is a tracked PrCheck row AND the
  // feature is enabled.
  if (args.prCheckId && project.qualityEnabled) {
    await runQualityForPrCheck({
      prCheckId: args.prCheckId,
      installationId: args.installationId,
      repoFullName: args.repoFullName,
      prNumber: args.prNumber,
      project,
    }).catch((e) =>
      logger.warn(
        { err: e, prCheckId: args.prCheckId },
        "runQualityForPrCheck failed"
      )
    );
  }
}

async function ensureProjectLabels(args: {
  installationId: number;
  fullName: string;
  pending: string;
  approved: string;
  denied: string;
  evaluate: string;
}): Promise<void> {
  const ref = repoRef(args.fullName, args.installationId);
  await Promise.all([
    ensureLabel(ref, args.pending, "fbca04", "Awaiting application review"),
    ensureLabel(ref, args.approved, "0e8a16", "Approved contributor"),
    ensureLabel(ref, args.denied, "b60205", "Application denied"),
    ensureLabel(
      ref,
      args.evaluate,
      "5319e7",
      "Add to trigger a re-evaluation by the contribution checker"
    ),
  ]).catch((e) =>
    logger.warn({ err: e, fullName: args.fullName }, "ensureProjectLabels failed")
  );
}

export async function handlePullRequestEvent(payload: WebhookPayload) {
  const action = payload.action ?? "";
  const isReEvalLabel = action === "labeled";
  if (
    !payload.pull_request ||
    !payload.repository ||
    !payload.installation ||
    !(
      ["opened", "reopened", "ready_for_review", "synchronize"].includes(action) ||
      isReEvalLabel
    )
  ) {
    return;
  }

  const repoFullName = payload.repository.full_name;
  const ghRepoId = payload.repository.id;
  const installationId = payload.installation.id;
  const prNumber = payload.pull_request.number;
  const prNodeId = payload.pull_request.node_id;
  const author = payload.pull_request.user;
  const headSha = payload.pull_request.head?.sha ?? null;
  const prIsClosed = payload.pull_request.state === "closed";

  // For "labeled" events we only care about the project's evaluate label.
  // Anything else (the bot's own status labels included) must short-circuit
  // before we touch the DB or run the decision pipeline.
  if (isReEvalLabel) {
    const labelName = payload.label?.name;
    if (!labelName) return;
    const repoForLabelGate = await prisma.repo.findUnique({
      where: { ghRepoId },
      select: { project: { select: { labelEvaluate: true } } },
    });
    if (!repoForLabelGate || repoForLabelGate.project.labelEvaluate !== labelName) {
      return;
    }
  }

  const decision = await decideForPR({
    ghRepoId,
    prAuthorGhLogin: author.login,
    prAuthorGhId: author.id,
  });

  const decisionAttrs: Record<string, string> = {
    "decision.outcome": decision.status,
  };
  if ("reason" in decision && decision.reason) {
    decisionAttrs["decision.reason"] = String(decision.reason);
  }
  if ("bypassReason" in decision && decision.bypassReason) {
    decisionAttrs["decision.bypass_reason"] = decision.bypassReason;
  }
  if (decision.projectId) decisionAttrs["project.id"] = decision.projectId;
  Sentry.getCurrentScope().setAttributes(decisionAttrs);

  if (decision.status === "IGNORED") {
    logger.debug({ ghRepoId, prNumber, reason: decision.reason }, "PR ignored");
    return;
  }

  // Look up project for label config + apply URL
  const project = decision.projectId
    ? await prisma.project.findUnique({
        where: { id: decision.projectId },
        select: {
          id: true,
          slug: true,
          name: true,
          labelsEnabled: true,
          labelPending: true,
          labelApproved: true,
          labelDenied: true,
          labelEvaluate: true,
          checkerEnabled: true,
          trackWhenDisabled: true,
          checksEnabled: true,
          qualityEnabled: true,
          qualityConfig: true,
          qualityCommentMin: true,
          prTemplateHoneypots: true,
        },
      })
    : null;
  if (!project) return;

  const disabledByChecker =
    decision.status === "APPROVED" && decision.bypassReason === "checker_disabled";
  const shouldTrackPr = !disabledByChecker || project.trackWhenDisabled;
  let prCheckId: string | null = null;

  // Persist PrCheck (skipped when checker is disabled and tracking is off)
  const prCheckStatus =
    decision.status === "APPROVED" || decision.status === "BYPASSED"
      ? "APPROVED"
      : decision.status === "DENIED"
        ? "DENIED"
        : "PENDING";
  if (decision.repoId && shouldTrackPr) {
    const prCheck = await prisma.prCheck.upsert({
      where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
      update: {
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status: prCheckStatus,
        ...(headSha ? { headSha } : {}),
      },
      create: {
        repoId: decision.repoId,
        prNumber,
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status: prCheckStatus,
        closedByApp: false,
        headSha,
      },
    });
    prCheckId = prCheck.id;
  }

  const ref = repoRef(repoFullName, installationId);
  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;

  if (project.labelsEnabled) {
    await ensureProjectLabels({
      installationId,
      fullName: repoFullName,
      pending: project.labelPending,
      approved: project.labelApproved,
      denied: project.labelDenied,
      evaluate: project.labelEvaluate,
    });
  }

  // Always strip the evaluate trigger label after a re-eval, regardless of
  // labelsEnabled — the admin added it to fire this run, leaving it on would
  // re-trigger on every subsequent webhook touch.
  const removeEvaluateLabel = async () => {
    if (!isReEvalLabel) return;
    await removeLabelIfPresent(ref, prNumber, project.labelEvaluate).catch(() =>
      undefined
    );
  };

  if (decision.status === "APPROVED" || decision.status === "BYPASSED") {
    // Re-eval on a previously closed-by-app PR: reopen it so the now-passing
    // decision has somewhere to land.
    if (isReEvalLabel && prIsClosed && decision.repoId) {
      const existing = await prisma.prCheck.findUnique({
        where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
        select: { closedByApp: true },
      });
      if (existing?.closedByApp) {
        try {
          await reopenPullRequest(
            ref,
            prNumber,
            `Re-evaluation by **${project.name}** passed — reopening this PR.`
          );
          await prisma.prCheck.update({
            where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
            data: { closedByApp: false },
          });
        } catch (e) {
          logger.warn(
            { err: e, repoFullName, prNumber },
            "re-eval reopen failed"
          );
        }
      }
    }
    if (project.labelsEnabled) {
      await Promise.all([
        removeLabelIfPresent(ref, prNumber, project.labelPending).catch(() => undefined),
        removeLabelIfPresent(ref, prNumber, project.labelDenied).catch(() => undefined),
        setLabels(ref, prNumber, [project.labelApproved]).catch(() => undefined),
      ]);
    }
    await removeEvaluateLabel();
    await postDecisionSideEffects({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      prCheckId,
      project,
      decision,
      applyUrl,
    });
    return;
  }

  // PENDING or DENIED → close + comment + label
  const body =
    buildDecisionMessage({
      decision,
      projectName: project.name,
      applyUrl,
      ghLogin: author.login,
    }) ?? "";

  try {
    // Skip the close+comment when the PR is already closed (the only path
    // that gets here closed is a re-eval label add). Re-closing would post a
    // duplicate decision comment on every label re-trigger.
    if (!prIsClosed) {
      await closePullRequest(ref, prNumber, body);
      if (decision.repoId && shouldTrackPr) {
        await prisma.prCheck.update({
          where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
          data: { closedByApp: true },
        });
      }
      await enqueueProjectWebhook({
        projectId: project.id,
        event: "pr.blocked",
        payload: {
          repo: repoFullName,
          prNumber,
          ghLogin: author.login,
          reason: decision.status === "PENDING" ? "no-application" : "denied",
        },
      });
    }
    if (project.labelsEnabled) {
      const targetLabel =
        decision.status === "PENDING" ? project.labelPending : project.labelDenied;
      const otherLabels = [
        project.labelApproved,
        decision.status === "PENDING" ? project.labelDenied : project.labelPending,
      ];
      await Promise.all(
        otherLabels.map((l) =>
          removeLabelIfPresent(ref, prNumber, l).catch(() => undefined)
        )
      );
      await setLabels(ref, prNumber, [targetLabel]).catch(() => undefined);
    }
  } catch (e) {
    logger.error({ err: e, repoFullName, prNumber }, "PR close/label failed");
  }

  await removeEvaluateLabel();

  await postDecisionSideEffects({
    installationId,
    repoFullName,
    prNumber,
    headSha,
    prCheckId,
    project,
    decision,
    applyUrl,
  });
}

export async function handleInstallationEvent(payload: WebhookPayload) {
  if (!payload.installation) return;
  const installationId = payload.installation.id;

  // Initial install (and re-activations) carry the repo list inline in the
  // `repositories` field — no separate `installation_repositories` event is
  // fired for the first batch. Link those to any manually-entered rows so the
  // PR webhook can find them by ghRepoId.
  if (
    (payload.action === "created" ||
      payload.action === "new_permissions_accepted" ||
      payload.action === "unsuspend") &&
    payload.repositories
  ) {
    await attachInstallationToManualRepos({
      installationId,
      repos: payload.repositories,
    });
    return;
  }

  // Detach repos from the installation when the App is uninstalled or
  // suspended. The Repo row stays so the project still lists the repo; it
  // just falls back to the "App not installed" state and can be re-linked.
  if (payload.action === "deleted" || payload.action === "suspend") {
    await prisma.repo.updateMany({
      where: { installationId },
      data: { installationId: null, ghRepoId: null },
    });
  }
}

export async function handleInstallationReposEvent(payload: WebhookPayload) {
  // When repos are removed from an installation, deactivate them
  if (
    payload.action === "removed" &&
    payload.repositories_removed &&
    payload.installation
  ) {
    const ghRepoIds = payload.repositories_removed.map((r) => r.id);
    if (ghRepoIds.length === 0) return;
    await prisma.repo.updateMany({
      where: {
        ghRepoId: { in: ghRepoIds },
        installationId: payload.installation.id,
      },
      data: { installationId: null, ghRepoId: null },
    });
  }
  // When repos are added to an installation, attach App metadata to any
  // manually-entered Repo rows whose fullName matches.
  if (
    payload.action === "added" &&
    payload.repositories_added &&
    payload.installation
  ) {
    await attachInstallationToManualRepos({
      installationId: payload.installation.id,
      repos: payload.repositories_added,
    });
  }
}
