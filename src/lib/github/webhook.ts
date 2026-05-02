import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { decideForPR } from "@/lib/applications/decide-pr";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import {
  closePullRequest,
  ensureLabel,
  removeLabelIfPresent,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";

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
  };
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
};

async function ensureProjectLabels(args: {
  installationId: number;
  fullName: string;
  pending: string;
  approved: string;
  denied: string;
}): Promise<void> {
  const ref = repoRef(args.fullName, args.installationId);
  await Promise.all([
    ensureLabel(ref, args.pending, "fbca04", "Awaiting application review"),
    ensureLabel(ref, args.approved, "0e8a16", "Approved contributor"),
    ensureLabel(ref, args.denied, "b60205", "Application denied"),
  ]).catch((e) =>
    logger.warn({ err: e, fullName: args.fullName }, "ensureProjectLabels failed")
  );
}

export async function handlePullRequestEvent(payload: WebhookPayload) {
  if (
    !payload.pull_request ||
    !payload.repository ||
    !payload.installation ||
    !["opened", "reopened", "ready_for_review"].includes(payload.action ?? "")
  ) {
    return;
  }

  const repoFullName = payload.repository.full_name;
  const ghRepoId = payload.repository.id;
  const installationId = payload.installation.id;
  const prNumber = payload.pull_request.number;
  const prNodeId = payload.pull_request.node_id;
  const author = payload.pull_request.user;

  const decision = await decideForPR({
    ghRepoId,
    prAuthorGhLogin: author.login,
    prAuthorGhId: author.id,
  });

  if (decision.status === "IGNORED") {
    logger.debug({ ghRepoId, prNumber, reason: decision.reason }, "PR ignored");
    return;
  }

  // Persist PrCheck
  if (decision.repoId) {
    await prisma.prCheck.upsert({
      where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
      update: {
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status:
          decision.status === "APPROVED" || decision.status === "BYPASSED"
            ? "APPROVED"
            : decision.status === "DENIED"
              ? "DENIED"
              : "PENDING",
      },
      create: {
        repoId: decision.repoId,
        prNumber,
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status:
          decision.status === "APPROVED" || decision.status === "BYPASSED"
            ? "APPROVED"
            : decision.status === "DENIED"
              ? "DENIED"
              : "PENDING",
        closedByApp: false,
      },
    });
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
        },
      })
    : null;
  if (!project) return;

  const ref = repoRef(repoFullName, installationId);
  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;

  if (project.labelsEnabled) {
    await ensureProjectLabels({
      installationId,
      fullName: repoFullName,
      pending: project.labelPending,
      approved: project.labelApproved,
      denied: project.labelDenied,
    });
  }

  if (decision.status === "APPROVED" || decision.status === "BYPASSED") {
    if (project.labelsEnabled) {
      await Promise.all([
        removeLabelIfPresent(ref, prNumber, project.labelPending).catch(() => undefined),
        removeLabelIfPresent(ref, prNumber, project.labelDenied).catch(() => undefined),
        setLabels(ref, prNumber, [project.labelApproved]).catch(() => undefined),
      ]);
    }
    return;
  }

  // PENDING or DENIED → close + comment + label
  let body: string;
  if (decision.status === "PENDING") {
    body =
      `Hi @${author.login}! Thanks for the PR. ` +
      `Contributions to **${project.name}** are gated behind a short application. ` +
      `Please apply at ${applyUrl} and we'll reopen this PR once you're approved.`;
  } else {
    body =
      `Hi @${author.login}, your application for **${project.name}** was previously declined` +
      (decision.reason ? `: ${decision.reason}` : "") +
      `. ` +
      (decision.cooldownUntil
        ? `You may re-apply on ${decision.cooldownUntil.toISOString().slice(0, 10)}.`
        : `Please contact a project admin if you believe this is in error.`);
  }

  try {
    await closePullRequest(ref, prNumber, body);
    if (decision.repoId) {
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
}

export async function handleInstallationEvent(payload: WebhookPayload) {
  // Mark repos as inactive when the App is uninstalled
  if (payload.action === "deleted" && payload.installation) {
    await prisma.repo.updateMany({
      where: { installationId: payload.installation.id },
      data: { active: false },
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
      data: { active: false },
    });
  }
  // Note: `added` events are deliberately ignored — repos are only linked
  // when the user explicitly selects them in the dashboard after install.
}
