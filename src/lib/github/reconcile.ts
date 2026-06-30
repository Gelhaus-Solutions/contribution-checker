import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  decideForRepo,
  decisionRepoInclude,
} from "@/lib/applications/decide-pr";
import {
  reopenPullRequest,
  removeLabelIfPresent,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";

const RECONCILE_BATCH_CAP = 200;

/**
 * App-mode safety net: re-evaluate PRs we previously closed and reopen any that
 * now pass. This is belt-and-suspenders for the webhook path — normally a PR is
 * reopened the instant its author's application is approved, but a dropped
 * webhook, a manual-decision change applied while the bot was down, or a
 * bypass-list edit could leave a closed PR that should be open. CI-mode repos
 * (no installationId) are skipped: there we have no token to act, and the
 * Action's own reconcile workflow handles them.
 *
 * Idempotent: only PRs with `closedByApp = true` are touched, and reopening an
 * already-open PR is a no-op on GitHub's side.
 */
export async function reconcileProjectClosedPrs(
  projectId: string
): Promise<{ reopened: number; evaluated: number }> {
  if (!env.githubAppConfigured) return { reopened: 0, evaluated: 0 };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      labelsEnabled: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
    },
  });
  if (!project) return { reopened: 0, evaluated: 0 };

  const repos = await prisma.repo.findMany({
    where: { projectId, active: true, installationId: { not: null } },
    include: decisionRepoInclude,
  });

  let reopened = 0;
  let evaluated = 0;

  for (const repo of repos) {
    if (repo.installationId == null) continue;
    const closed = await prisma.prCheck.findMany({
      where: {
        repoId: repo.id,
        status: { in: ["PENDING", "DENIED"] },
        closedByApp: true,
      },
      orderBy: { updatedAt: "desc" },
      take: RECONCILE_BATCH_CAP,
    });

    const ref = repoRef(repo.fullName, repo.installationId);

    for (const check of closed) {
      evaluated += 1;
      const decision = await decideForRepo({
        repo,
        prAuthorGhLogin: check.authorGhLogin,
        prAuthorGhId: check.authorGhId,
      });
      const allowing =
        decision.status === "APPROVED" || decision.status === "BYPASSED";
      if (!allowing) continue;

      try {
        await reopenPullRequest(
          ref,
          check.prNumber,
          "Reopened: your contribution is now approved."
        );
        if (project.labelsEnabled) {
          await removeLabelIfPresent(ref, check.prNumber, project.labelPending);
          await removeLabelIfPresent(ref, check.prNumber, project.labelDenied);
          await setLabels(ref, check.prNumber, [project.labelApproved]);
        }
        await prisma.prCheck.update({
          where: { id: check.id },
          data: { status: "APPROVED", closedByApp: false },
        });
        reopened += 1;
      } catch (e) {
        logger.warn(
          { err: e, prCheckId: check.id, prNumber: check.prNumber },
          "reconcile: reopen failed"
        );
      }
    }
  }

  logger.info({ projectId, reopened, evaluated }, "reconcile sweep complete");
  return { reopened, evaluated };
}

/** Every project that has at least one active App-mode repo — the work-list for
 * the scheduled reconcile sweep. */
export async function projectIdsWithAppRepos(): Promise<string[]> {
  const rows = await prisma.repo.findMany({
    where: { active: true, installationId: { not: null } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  return rows.map((r) => r.projectId);
}
