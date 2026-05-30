import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { applyUrl as buildApplyUrl } from "@/lib/notifications/email";
import {
  decideForRepo,
  decisionRepoInclude,
  type PrDecision,
} from "@/lib/applications/decide-pr";
import {
  publishDecisionCheck,
  publishClaCheck,
  type ClaCheckState,
} from "@/lib/github/check-run";
import {
  removeLabelIfPresent,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";
import { invalidateClaCache } from "@/lib/cla/status";

const CLA_PROJECT_SELECT = {
  id: true,
  slug: true,
  name: true,
  checksEnabled: true,
  labelsEnabled: true,
  labelApproved: true,
  labelClaPending: true,
  repos: {
    where: { active: true, installationId: { not: null } },
    select: { id: true, fullName: true, installationId: true },
  },
} as const;

// Gate reasons that mean a PR is being held open by a failing CLA Check. DCO
// (dco_missing) is excluded: it is re-derived from PR commits in the webhook/CI
// layer, not by a coverage change for a single author.
const CLA_GATE_REASONS = ["cla_required", "cla_stale"] as const;

/**
 * Re-evaluate a contributor's open, CLA-gated PRs after their coverage changed
 * (ICLA sign, CCLA roster add, waiver grant, etc.). For PRs whose fresh
 * decision now allows, re-publish a PASSING Check and swap the cla-pending
 * label for the approved label. These PRs were never closed (CLA/DCO keep PRs
 * open), so there is nothing to reopen.
 *
 * Mirrors `src/lib/github/post-decision.ts`: env guard, load the project's
 * active+installed repos, iterate matching PrCheck rows with inline awaits and
 * a per-PR try/catch that only logs warnings.
 */
export async function onClaCoverageChanged(args: {
  projectId: string;
  ghId: number;
}): Promise<{ rechecked: number }> {
  // Drop the cached coverage result first so the fresh decision sees the new
  // signature/roster/waiver state.
  invalidateClaCache(args.projectId, args.ghId);

  if (!env.githubAppConfigured) return { rechecked: 0 };

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: CLA_PROJECT_SELECT,
  });
  if (!project) return { rechecked: 0 };

  const repoIds = project.repos.map((r) => r.id);
  if (repoIds.length === 0) return { rechecked: 0 };

  // PRs this author is holding open behind a failing CLA Check.
  const checks = await prisma.prCheck.findMany({
    where: {
      repoId: { in: repoIds },
      authorGhId: args.ghId,
      status: "CHECK_REQUIRED",
      gateReason: { in: [...CLA_GATE_REASONS] },
    },
    include: { repo: { include: decisionRepoInclude } },
  });
  if (checks.length === 0) return { rechecked: 0 };

  const applyUrl = buildApplyUrl(project.slug);
  const claUrl = `${applyUrl}/cla`;

  let rechecked = 0;
  for (const check of checks) {
    if (check.repo.installationId == null) continue;
    const ref = repoRef(check.repo.fullName, check.repo.installationId);
    try {
      const decision: PrDecision = await decideForRepo({
        repo: check.repo,
        prAuthorGhLogin: check.authorGhLogin,
        prAuthorGhId: check.authorGhId,
      });

      // Only flip PRs whose fresh decision is now allowing. Anything else
      // (still CHECK_REQUIRED, or newly DENIED/PENDING/etc.) is left untouched
      // for the regular decision pipeline to handle.
      if (decision.status !== "APPROVED" && decision.status !== "BYPASSED") {
        continue;
      }

      await publishDecisionCheck({
        installationId: check.repo.installationId,
        repoFullName: check.repo.fullName,
        prCheckId: check.id,
        headSha: check.headSha,
        project: {
          id: project.id,
          slug: project.slug,
          name: project.name,
          checksEnabled: project.checksEnabled,
        },
        decision,
        applyUrl,
        claUrl,
      });

      // Re-publish the dedicated `contribution-checker / cla` check too. The
      // webhook publishes both checks, but only the decision check was being
      // refreshed here, so a maintainer who required the CLA check in branch
      // protection saw it stay stuck on "CLA required" after the signature.
      // An allowing decision means decideForRepo's CLA gate passed (coverage is
      // satisfied); bot/disabled edge cases are mapped explicitly to mirror the
      // webhook's claState computation.
      const claState: ClaCheckState =
        decision.status === "BYPASSED" && decision.reason === "bot"
          ? "exempt"
          : decision.status === "APPROVED" &&
              decision.bypassReason === "checker_disabled"
            ? "not_required"
            : "satisfied";
      await publishClaCheck({
        installationId: check.repo.installationId,
        repoFullName: check.repo.fullName,
        prCheckId: check.id,
        headSha: check.headSha,
        project: {
          id: project.id,
          name: project.name,
          checksEnabled: project.checksEnabled,
        },
        state: claState,
        claUrl,
      });

      if (project.labelsEnabled) {
        await Promise.all([
          removeLabelIfPresent(ref, check.prNumber, project.labelClaPending).catch(
            () => undefined
          ),
          setLabels(ref, check.prNumber, [project.labelApproved]).catch(
            () => undefined
          ),
        ]);
      }

      await prisma.prCheck.update({
        where: { id: check.id },
        data: { status: "APPROVED", gateReason: null },
      });
      rechecked++;
    } catch (e) {
      logger.warn(
        { err: e, repoId: check.repoId, prNumber: check.prNumber },
        "cla recheck failed"
      );
    }
  }
  return { rechecked };
}
