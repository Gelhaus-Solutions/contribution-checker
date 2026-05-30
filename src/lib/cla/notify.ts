import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications/inbox";
import { applyUrl, emailUserById } from "@/lib/notifications/email";
import { getClaStatus } from "@/lib/cla/status";
import {
  reapplyClaGateForApprovedAuthor,
  notifyPendingApplicantsOnPrs,
} from "@/lib/cla/post-sign";

const PROJECT_SELECT = {
  id: true,
  slug: true,
  name: true,
  claEnabled: true,
  claRequired: true,
  currentIclaVersionId: true,
} as const;

/**
 * Remind a single applicant that they must sign the project's CLA, delivered
 * in-app and by email. No-ops (silently) unless every precondition holds, so
 * callers can fire-and-forget:
 *   - the project has CLA enabled AND required,
 *   - a current ICLA version exists (there is something to sign),
 *   - the user has a GitHub identity (ghId + ghLogin),
 *   - the user is not already covered (ICLA / CCLA roster / waiver), and
 *   - no unread CLA-sign reminder for this (user, project) already exists.
 *
 * Returns true when a reminder was sent, false when skipped. Never throws: the
 * three call sites (apply submit, settings toggle, admin button) are all
 * best-effort and must not fail their primary action.
 */
export async function notifyApplicantClaRequired(args: {
  userId: string;
  projectId: string;
}): Promise<boolean> {
  try {
    const [project, user] = await Promise.all([
      prisma.project.findUnique({
        where: { id: args.projectId },
        select: PROJECT_SELECT,
      }),
      prisma.user.findUnique({
        where: { id: args.userId },
        select: { id: true, ghId: true, ghLogin: true },
      }),
    ]);
    if (!project || !user) return false;
    if (!project.claEnabled || !project.claRequired) return false;
    if (!project.currentIclaVersionId) return false; // nowhere to sign yet
    if (user.ghId == null || user.ghLogin == null) return false;

    const status = await getClaStatus({
      projectId: project.id,
      ghId: user.ghId,
      ghLogin: user.ghLogin,
    });
    if (status.satisfied) return false; // already covered

    // Idempotency: don't pile up reminders. Skip when an unread CLA-sign
    // reminder for this project already sits in the user's inbox. The payload
    // is a JSON string, so match the projectId field directly.
    const existing = await prisma.notification.findFirst({
      where: {
        userId: user.id,
        readAt: null,
        kind: { in: ["cla.signature_required", "cla.resign_required"] },
        payload: { contains: `"projectId":"${project.id}"` },
      },
      select: { id: true },
    });
    if (existing) return false;

    const kind = status.needsResign
      ? "cla.resign_required"
      : "cla.signature_required";
    const payload = {
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
    };
    await notifyUser({ userId: user.id, kind, payload });

    const claUrl = `${applyUrl(project.slug)}/cla`;
    const subject = status.needsResign
      ? `Action needed: re-sign the CLA for ${project.name}`
      : `Action needed: sign the CLA for ${project.name}`;
    const text = status.needsResign
      ? `The Contributor License Agreement for ${project.name} was updated, ` +
        `so you need to re-sign the current version before your contributions ` +
        `can be accepted.\n\nSign here: ${claUrl}\n`
      : `You have an application for ${project.name}, but this project ` +
        `requires a signed Contributor License Agreement before your ` +
        `contributions can be accepted.\n\nSign here: ${claUrl}\n`;
    await emailUserById({ userId: user.id, subject, text });

    return true;
  } catch (e) {
    logger.warn(
      { err: e, userId: args.userId, projectId: args.projectId },
      "cla: applicant reminder failed",
    );
    return false;
  }
}

/**
 * Tell a submitted-but-undecided applicant that their application is in the
 * review queue, in-app and by email. Deduped on an unread awaiting-review notice
 * for the project so repeat sweeps never pile up. Best-effort; returns true when
 * a notice was sent. The caller (the sweep) guarantees the user has a SUBMITTED
 * application; this is the in-app/email half, the PR comment is posted by
 * {@link notifyPendingApplicantsOnPrs}.
 */
export async function notifyPendingApplicant(args: {
  userId: string;
  projectId: string;
}): Promise<boolean> {
  try {
    const [project, user] = await Promise.all([
      prisma.project.findUnique({
        where: { id: args.projectId },
        select: { id: true, slug: true, name: true },
      }),
      prisma.user.findUnique({
        where: { id: args.userId },
        select: { id: true },
      }),
    ]);
    if (!project || !user) return false;

    const existing = await prisma.notification.findFirst({
      where: {
        userId: user.id,
        readAt: null,
        kind: "application.awaiting_review",
        payload: { contains: `"projectId":"${project.id}"` },
      },
      select: { id: true },
    });
    if (existing) return false;

    await notifyUser({
      userId: user.id,
      kind: "application.awaiting_review",
      payload: {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.name,
      },
    });
    await emailUserById({
      userId: user.id,
      subject: `Your application for ${project.name} is awaiting review`,
      text:
        `Thanks for applying to ${project.name}. Your application is in the ` +
        `review queue and a maintainer will decide on it soon. You can check ` +
        `the status here: ${applyUrl(project.slug)}\n`,
    });
    return true;
  } catch (e) {
    logger.warn(
      { err: e, userId: args.userId, projectId: args.projectId },
      "pending-applicant notice failed",
    );
    return false;
  }
}

/**
 * Notify every applicant of a project who still needs to sign the CLA. Used
 * retroactively when the CLA requirement turns on (or the first ICLA is
 * published) and from the admin "Notify unsigned applicants" button.
 *
 * Bounded to 200 applications per run (mirrors the quality-backfill cap). For
 * applicants whose application is already APPROVED, also re-applies the CLA gate
 * to their open PRs so the standard failing Check + comment appear there too;
 * SUBMITTED applicants get only the in-app + email reminder (their PR is held by
 * the pending-application gate, not the CLA).
 */
export async function sweepUnsignedApplicants(args: {
  projectId: string;
  actorId: string | null;
}): Promise<{ notified: number; skipped: number; total: number }> {
  const apps = await prisma.application.findMany({
    where: {
      projectId: args.projectId,
      status: { in: ["SUBMITTED", "APPROVED"] },
    },
    select: { userId: true, status: true, user: { select: { ghId: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Dedupe by user, keeping the strongest status (APPROVED beats SUBMITTED) so a
  // user with several applications is notified once and PR-re-gated only when
  // genuinely approved.
  const byUser = new Map<
    string,
    { status: "SUBMITTED" | "APPROVED"; ghId: number | null }
  >();
  for (const a of apps) {
    const prev = byUser.get(a.userId);
    if (prev?.status === "APPROVED") continue;
    byUser.set(a.userId, {
      status: a.status === "APPROVED" ? "APPROVED" : "SUBMITTED",
      ghId: a.user.ghId,
    });
  }

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "cla.notify_unsigned_started",
    payload: { candidates: byUser.size },
  });

  let notified = 0;
  let skipped = 0;
  const submittedGhIds: number[] = [];
  for (const [userId, info] of byUser) {
    const sent = await notifyApplicantClaRequired({
      userId,
      projectId: args.projectId,
    });
    if (sent) notified += 1;
    else skipped += 1;

    if (info.status === "SUBMITTED") {
      // Submitted-but-undecided: nudge them that their application is in the
      // review queue (in-app + email). Their open PR is also commented below.
      await notifyPendingApplicant({
        userId,
        projectId: args.projectId,
      }).catch(() => undefined);
      if (info.ghId != null) submittedGhIds.push(info.ghId);
    }

    // Approved-but-uncovered authors: (re)apply the CLA gate to their open PRs.
    // Idempotent and never closes a PR (acts only on a CHECK_REQUIRED
    // re-decision), so it is safe to run on every sweep even when the inbox
    // reminder above was deduped.
    if (info.status === "APPROVED" && info.ghId != null) {
      await reapplyClaGateForApprovedAuthor({
        projectId: args.projectId,
        ghId: info.ghId,
      }).catch(() => undefined);
    }
  }

  // Post the "awaiting review" comment on submitted applicants' open PRs (a
  // fresh comment, so GitHub notifies them), with the CLA heads-up when they are
  // uncovered. Project-wide, bounded, idempotent; best-effort.
  await notifyPendingApplicantsOnPrs({
    projectId: args.projectId,
    ghIds: submittedGhIds,
  }).catch(() => undefined);

  await recordAudit({
    projectId: args.projectId,
    actorId: args.actorId,
    kind: "cla.notify_unsigned_completed",
    payload: { notified, skipped, total: byUser.size },
  });

  return { notified, skipped, total: byUser.size };
}
