import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import {
  closePullRequest,
  removeLabelIfPresent,
  reopenPullRequest,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";

const APPLICATION_PROJECT_SELECT = {
  id: true,
  slug: true,
  name: true,
  labelsEnabled: true,
  labelPending: true,
  labelApproved: true,
  labelDenied: true,
} as const;

/**
 * On approval: find PRs we previously closed for this user across the
 * project's repos, reopen them, and update labels.
 */
export async function onApplicationApproved(args: {
  applicationId: string;
}): Promise<{ reopened: number }> {
  if (!env.githubAppConfigured) return { reopened: 0 };

  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      user: { select: { ghId: true, ghLogin: true } },
      project: {
        select: {
          ...APPLICATION_PROJECT_SELECT,
          repos: {
            where: { active: true, installationId: { not: null } },
            select: { id: true, fullName: true, installationId: true },
          },
        },
      },
    },
  });
  if (!app || !app.user.ghId) return { reopened: 0 };

  const repoIds = app.project.repos.map((r) => r.id);
  const reopens = await prisma.prCheck.findMany({
    where: {
      repoId: { in: repoIds },
      authorGhId: app.user.ghId,
      status: "PENDING",
      closedByApp: true,
    },
    include: { repo: { select: { id: true, fullName: true, installationId: true } } },
  });

  let reopened = 0;
  for (const check of reopens) {
    if (check.repo.installationId == null) continue;
    const ref = repoRef(check.repo.fullName, check.repo.installationId);
    try {
      await reopenPullRequest(
        ref,
        check.prNumber,
        `@${app.user.ghLogin}'s application for **${app.project.name}** was approved — reopening this PR.`
      );
      if (app.project.labelsEnabled) {
        await Promise.all([
          removeLabelIfPresent(ref, check.prNumber, app.project.labelPending).catch(() => undefined),
          removeLabelIfPresent(ref, check.prNumber, app.project.labelDenied).catch(() => undefined),
          setLabels(ref, check.prNumber, [app.project.labelApproved]).catch(() => undefined),
        ]);
      }
      await prisma.prCheck.update({
        where: { id: check.id },
        data: { status: "APPROVED", closedByApp: false },
      });
      reopened++;
    } catch (e) {
      logger.warn(
        { err: e, repoId: check.repoId, prNumber: check.prNumber },
        "reopen failed"
      );
    }
  }
  return { reopened };
}

/**
 * On revocation with `closeOpenPrs`: find currently-open PRs by this user
 * in the project's repos and close them with a comment.
 */
export async function onApplicationRevokedWithClose(args: {
  applicationId: string;
  reason?: string | null;
}): Promise<{ closed: number }> {
  if (!env.githubAppConfigured) return { closed: 0 };

  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      user: { select: { ghId: true, ghLogin: true } },
      project: {
        select: {
          ...APPLICATION_PROJECT_SELECT,
          repos: {
            where: { active: true, installationId: { not: null } },
            select: { id: true, fullName: true, installationId: true },
          },
        },
      },
    },
  });
  if (!app || !app.user.ghId) return { closed: 0 };

  const repoIds = app.project.repos.map((r) => r.id);
  const checks = await prisma.prCheck.findMany({
    where: {
      repoId: { in: repoIds },
      authorGhId: app.user.ghId,
      status: "APPROVED",
    },
    include: { repo: { select: { id: true, fullName: true, installationId: true } } },
  });

  let closed = 0;
  for (const check of checks) {
    if (check.repo.installationId == null) continue;
    const ref = repoRef(check.repo.fullName, check.repo.installationId);
    const body =
      `@${app.user.ghLogin}, your contributor approval for **${app.project.name}** has been revoked` +
      (args.reason ? `: ${args.reason}` : "") +
      `. This PR is being closed.`;
    try {
      await closePullRequest(ref, check.prNumber, body);
      if (app.project.labelsEnabled) {
        await Promise.all([
          removeLabelIfPresent(ref, check.prNumber, app.project.labelApproved).catch(() => undefined),
          setLabels(ref, check.prNumber, [app.project.labelDenied]).catch(() => undefined),
        ]);
      }
      await prisma.prCheck.update({
        where: { id: check.id },
        data: { status: "PENDING", closedByApp: true },
      });
      closed++;
    } catch (e) {
      logger.warn(
        { err: e, repoId: check.repoId, prNumber: check.prNumber },
        "close-on-revoke failed"
      );
    }
  }
  return { closed };
}
