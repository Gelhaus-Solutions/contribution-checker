import {
  onApplicationApproved,
  onApplicationDenied,
  onApplicationRevokedWithClose,
} from "@/lib/github/post-decision";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications/inbox";
import { emailUserById, applyUrl } from "@/lib/notifications/email";
import type {
  ApplicationDecisionInput,
  ApplicationDecisionResult,
} from "@/lib/temporal/contracts";

/**
 * Run the GitHub-facing fan-out for an application decision. The reopen-all /
 * close-all / relabel loops in post-decision.ts are already idempotent (guarded
 * by the `closedByApp` flag + status filters), so re-running on activity retry
 * is safe.
 */
export async function runApplicationPostDecision(
  input: ApplicationDecisionInput
): Promise<ApplicationDecisionResult> {
  switch (input.kind) {
    case "approved": {
      const { reopened } = await onApplicationApproved({
        applicationId: input.applicationId,
      });
      return { affectedPrs: reopened };
    }
    case "denied": {
      const { updated } = await onApplicationDenied({
        applicationId: input.applicationId,
      });
      return { affectedPrs: updated };
    }
    case "revoked": {
      const reason =
        typeof input.args.reason === "string" ? input.args.reason : null;
      const { closed } = await onApplicationRevokedWithClose({
        applicationId: input.applicationId,
        reason,
      });
      return { affectedPrs: closed };
    }
  }
}

/**
 * Cooldown elapsed: the durable timer fired at cooldownUntil. Clear the expired
 * cooldown so the decision pipeline stops gating on it, then proactively tell
 * the applicant they may re-apply. Idempotent and self-checking:
 *  - if an admin already approved/changed the application, do nothing;
 *  - if the cooldown was already cleared, do nothing;
 *  - if cooldownUntil is somehow still in the future, do nothing (the timer is
 *    the source of truth for *when*, but we still guard against clock surprises).
 */
export async function elapseApplicationCooldown(
  applicationId: string
): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      userId: true,
      projectId: true,
      status: true,
      cooldownUntil: true,
      allowResubmit: true,
      project: { select: { name: true, slug: true } },
    },
  });
  if (!app) return;
  if (app.status !== "DENIED") return;
  if (!app.cooldownUntil) return; // already cleared
  if (app.cooldownUntil.getTime() > Date.now()) return;

  await prisma.application.update({
    where: { id: applicationId },
    data: { allowResubmit: true, cooldownUntil: null },
  });

  await recordAudit({
    projectId: app.projectId,
    actorId: null,
    kind: "application.cooldown_elapsed",
    payload: { applicationId: app.id, applicantId: app.userId },
  });

  await notifyUser({
    userId: app.userId,
    kind: "application.resubmit_allowed",
    payload: { applicationId: app.id, projectSlug: app.project.slug },
  });

  await emailUserById({
    userId: app.userId,
    subject: `You may re-apply: ${app.project.name}`,
    text:
      `The cooldown on your ${app.project.name} application has elapsed.\n\n` +
      `You may submit a new application now.\n\n` +
      `${applyUrl(app.project.slug)}\n`,
  }).catch((e) =>
    logger.warn({ err: e, applicationId }, "cooldown-elapsed email failed")
  );

  logger.info({ applicationId }, "application cooldown elapsed; resubmit allowed");
}
