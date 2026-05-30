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
  ensureLabel,
  removeLabelIfPresent,
  setLabels,
  commentOnPr,
  prHasCommentContaining,
  repoRef,
} from "@/lib/github/pr-actions";
import { buildDecisionMessage } from "@/lib/applications/decision-message";
import { invalidateClaCache } from "@/lib/cla/status";
import { notifyUser } from "@/lib/notifications/inbox";

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
          removeLabelIfPresent(
            ref,
            check.prNumber,
            project.labelClaPending,
          ).catch(() => undefined),
          setLabels(ref, check.prNumber, [project.labelApproved]).catch(
            () => undefined,
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
        "cla recheck failed",
      );
    }
  }
  return { rechecked };
}

/**
 * Re-evaluate contributors' open, currently-PASSING PRs after their CLA coverage
 * was REVOKED (a previously-valid signed version was retroactively marked
 * resignRequired, e.g. an invalid published version retired). This is the
 * loss-direction counterpart to `onClaCoverageChanged`: it scans APPROVED
 * PrCheck rows and, for any whose fresh decision now reports a CLA gate, fails
 * the Check and applies the cla-pending label. The PR stays OPEN (CLA gates
 * never close PRs); the contributor must re-sign the current version to clear
 * it. Affected contributors with a linked account are notified to re-sign.
 *
 * Mirrors `onClaCoverageChanged`: env guard, load the project's active+installed
 * repos, iterate matching PrCheck rows with inline awaits and a per-PR try/catch
 * that only logs warnings. Idempotent: a PR already gated for the same reason is
 * simply re-published; a contributor still covered by another path (a second
 * ICLA, a CCLA roster) is left untouched because the fresh decision still
 * allows.
 */
export async function onClaCoverageRevoked(args: {
  projectId: string;
  ghIds: number[];
}): Promise<{ regated: number }> {
  const ghIds = Array.from(
    new Set(args.ghIds.filter((n) => Number.isFinite(n))),
  );
  for (const ghId of ghIds) invalidateClaCache(args.projectId, ghId);

  if (!env.githubAppConfigured || ghIds.length === 0) return { regated: 0 };

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: CLA_PROJECT_SELECT,
  });
  if (!project) return { regated: 0 };

  const repoIds = project.repos.map((r) => r.id);

  // Notify affected contributors (those with a linked account) to re-sign,
  // independent of whether they currently have an open PR.
  const users = await prisma.user.findMany({
    where: { ghId: { in: ghIds } },
    select: { id: true },
  });
  for (const u of users) {
    await notifyUser({
      userId: u.id,
      kind: "cla.resign_required",
      payload: { projectId: project.id, projectName: project.name },
    }).catch(() => undefined);
  }

  if (repoIds.length === 0) return { regated: 0 };

  // Open PRs these authors are currently passing. A revoked signature makes the
  // fresh decision a CLA gate; flip those to CHECK_REQUIRED.
  const checks = await prisma.prCheck.findMany({
    where: {
      repoId: { in: repoIds },
      authorGhId: { in: ghIds },
      status: "APPROVED",
    },
    include: { repo: { include: decisionRepoInclude } },
  });
  if (checks.length === 0) return { regated: 0 };

  const applyUrl = buildApplyUrl(project.slug);
  const claUrl = `${applyUrl}/cla`;

  let regated = 0;
  for (const check of checks) {
    if (check.repo.installationId == null) continue;
    const ref = repoRef(check.repo.fullName, check.repo.installationId);
    try {
      const decision: PrDecision = await decideForRepo({
        repo: check.repo,
        prAuthorGhLogin: check.authorGhLogin,
        prAuthorGhId: check.authorGhId,
      });

      // Only re-gate PRs whose fresh decision is now a CLA gate. Anything still
      // allowing (covered by another path) or in some other state is left for
      // the regular decision pipeline.
      if (
        decision.status !== "CHECK_REQUIRED" ||
        !CLA_GATE_REASONS.includes(
          decision.reason as (typeof CLA_GATE_REASONS)[number],
        )
      ) {
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

      const claState: ClaCheckState =
        decision.reason === "cla_stale" ? "stale" : "required";
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
        await ensureLabel(
          ref,
          project.labelClaPending,
          "fbca04",
          "Awaiting CLA signature / DCO sign-off",
        ).catch(() => undefined);
        await Promise.all([
          removeLabelIfPresent(
            ref,
            check.prNumber,
            project.labelApproved,
          ).catch(() => undefined),
          setLabels(ref, check.prNumber, [project.labelClaPending]).catch(
            () => undefined,
          ),
        ]);
      }

      await prisma.prCheck.update({
        where: { id: check.id },
        data: { status: "CHECK_REQUIRED", gateReason: decision.reason },
      });
      regated++;
    } catch (e) {
      logger.warn(
        { err: e, repoId: check.repoId, prNumber: check.prNumber },
        "cla re-gate failed",
      );
    }
  }
  return { regated };
}

/**
 * Apply the CLA gate to a single APPROVED-but-uncovered author's open PRs and
 * post the "sign the CLA" reminder comment on them. Used by the applicant sweep
 * (`sweepUnsignedApplicants`) for the retroactive case: the CLA requirement was
 * turned on (or the first ICLA published) while the contributor was already
 * approved, so their open PRs are tracked APPROVED and were never CLA-gated.
 *
 * Distinct from `onClaCoverageRevoked`: that handles coverage *loss* in batch
 * and notifies via the inbox; this is per-author, posts the PR *comment* (the
 * applicant's "comment on my PR" channel), and dedupes that comment so repeated
 * sweeps and prior manual re-evaluations never double-post.
 *
 * Safety: ACTS only when the fresh decision is CHECK_REQUIRED (a CLA gate), so
 * it can never close a PR; anything else (still allowing, DCO-only, or now
 * DENIED/PENDING) is left for the regular pipeline. Best-effort and idempotent;
 * mirrors the guards and per-PR try/catch of the functions above.
 */
export async function reapplyClaGateForApprovedAuthor(args: {
  projectId: string;
  ghId: number;
}): Promise<{ gated: number }> {
  invalidateClaCache(args.projectId, args.ghId);

  if (!env.githubAppConfigured) return { gated: 0 };

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: CLA_PROJECT_SELECT,
  });
  if (!project) return { gated: 0 };

  const repoIds = project.repos.map((r) => r.id);
  if (repoIds.length === 0) return { gated: 0 };

  // The author's tracked PRs that could currently be open and should now be
  // CLA-gated. Skip rows the app itself closed (pending/denied closes); a CLA
  // gate only ever layers on an allowing base.
  const checks = await prisma.prCheck.findMany({
    where: {
      repoId: { in: repoIds },
      authorGhId: args.ghId,
      closedByApp: false,
      status: { in: ["APPROVED", "BYPASSED", "CHECK_REQUIRED"] },
    },
    include: { repo: { include: decisionRepoInclude } },
  });
  if (checks.length === 0) return { gated: 0 };

  const applyUrl = buildApplyUrl(project.slug);
  const claUrl = `${applyUrl}/cla`;

  let gated = 0;
  for (const check of checks) {
    if (check.repo.installationId == null) continue;
    const ref = repoRef(check.repo.fullName, check.repo.installationId);
    try {
      const decision: PrDecision = await decideForRepo({
        repo: check.repo,
        prAuthorGhLogin: check.authorGhLogin,
        prAuthorGhId: check.authorGhId,
      });

      // Act only on a fresh CLA gate. Anything else (still allowing, DCO-only,
      // or now DENIED/PENDING) is left for the regular pipeline; never close.
      if (
        decision.status !== "CHECK_REQUIRED" ||
        !CLA_GATE_REASONS.includes(
          decision.reason as (typeof CLA_GATE_REASONS)[number],
        )
      ) {
        continue;
      }

      const claState: ClaCheckState =
        decision.reason === "cla_stale" ? "stale" : "required";

      // Don't double-post the reminder. First the cheap DB check (the row is
      // already gated for this reason, mirroring the webhook's alreadyGated),
      // then an authoritative GitHub check in case a reminder was already posted
      // out-of-band (a manual re-evaluation or a prior run) without our row
      // reflecting it. Matched by the CLA signing URL, which every reminder
      // (webhook or sweep) includes.
      const alreadyGated =
        check.status === "CHECK_REQUIRED" &&
        check.gateReason === decision.reason;
      if (!alreadyGated) {
        const alreadyPosted = await prHasCommentContaining(
          ref,
          check.prNumber,
          claUrl,
        );
        if (!alreadyPosted) {
          const body = buildDecisionMessage({
            decision,
            projectName: project.name,
            applyUrl,
            ghLogin: check.authorGhLogin,
            claUrl,
          });
          if (body) {
            await commentOnPr(ref, check.prNumber, body).catch(() => undefined);
          }
        }
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
        await ensureLabel(
          ref,
          project.labelClaPending,
          "fbca04",
          "Awaiting CLA signature / DCO sign-off",
        ).catch(() => undefined);
        await setLabels(ref, check.prNumber, [project.labelClaPending]).catch(
          () => undefined,
        );
      }

      await prisma.prCheck.update({
        where: { id: check.id },
        data: { status: "CHECK_REQUIRED", gateReason: decision.reason },
      });
      gated++;
    } catch (e) {
      logger.warn(
        { err: e, repoId: check.repoId, prNumber: check.prNumber },
        "cla applicant re-gate failed",
      );
    }
  }
  return { gated };
}
