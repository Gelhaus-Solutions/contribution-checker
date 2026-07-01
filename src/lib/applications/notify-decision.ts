import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { applyUrl, sendEmail } from "@/lib/notifications/email";
import type { NotificationKind } from "@/lib/notifications/inbox";
import type { ApplicationDecisionKind } from "@/lib/temporal/contracts";

/**
 * Applicant-facing inbox + email for an approve/deny/revoke decision. Moved
 * out of decide.ts's request path: the primary caller is the
 * runApplicationPostDecision ACTIVITY (after the GitHub fan-out), so a mail
 * outage retries durably instead of faulting the admin's action. start.ts
 * falls back to calling it inline (best-effort) when the applicant has no
 * GitHub identity and the contributor entity can't be signaled.
 *
 * Lives in its own module (not decide.ts) because decide.ts already imports
 * the webhooks module, which imports temporal/start; start.ts importing
 * decide.ts back would close an import cycle.
 *
 * Idempotency: the caller may pass a stable `dedupKey` (the activity uses
 * runId:activityId, constant across retries). It is embedded in the inbox
 * payload and an exact-match row check skips the re-insert; the email is sent
 * after the inbox write, so a retry that finds the row but got there because
 * the email failed re-attempts the email (at-least-once; a duplicate email is
 * only possible if the worker dies between email send and activity
 * completion). Without a dedupKey (inline fallback, no retries) no dedup
 * check runs.
 *
 * Self-checking like elapseApplicationCooldown: if the application's persisted
 * status no longer matches the decision kind (an admin re-decided before the
 * activity drained), the stale notification is skipped.
 */
export async function notifyApplicationDecision(args: {
  kind: ApplicationDecisionKind;
  applicationId: string;
  /** Decision reason; defaults to the application's persisted reason. */
  reason?: string | null;
  /** Revoke target for the follow-up copy; inferred from status if absent. */
  revokeTarget?: "DENIED" | "SUBMITTED" | "PENDING" | null;
  /** Stable retry-dedup key (activity runId:activityId). */
  dedupKey?: string;
}): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    select: {
      id: true,
      userId: true,
      projectId: true,
      status: true,
      reason: true,
      project: { select: { name: true, slug: true } },
    },
  });
  if (!app) {
    logger.warn(
      { applicationId: args.applicationId, kind: args.kind },
      "notifyApplicationDecision: application not found"
    );
    return;
  }

  // Stale-decision guard: only notify when the persisted status still matches
  // the decision this notification is for.
  const statusMatches =
    (args.kind === "approved" && app.status === "APPROVED") ||
    (args.kind === "denied" && app.status === "DENIED") ||
    (args.kind === "revoked" &&
      (app.status === "DENIED" || app.status === "SUBMITTED"));
  if (!statusMatches) {
    logger.info(
      { applicationId: app.id, kind: args.kind, status: app.status },
      "notifyApplicationDecision: status changed since decision; skipping"
    );
    return;
  }

  const reason = args.reason !== undefined ? args.reason : app.reason;
  const target =
    args.revokeTarget ?? (app.status === "SUBMITTED" ? "SUBMITTED" : null);
  const { name, slug } = app.project;

  let inboxKind: NotificationKind;
  let inboxPayload: Record<string, unknown>;
  let subject: string;
  let text: string;
  switch (args.kind) {
    case "approved":
      inboxKind = "application.approved";
      inboxPayload = {
        projectId: app.projectId,
        projectSlug: slug,
        projectName: name,
      };
      subject = `Approved: ${name}`;
      text =
        `Your application for ${name} was approved.\n\n` +
        `You can now open pull requests on the linked repositories.\n\n` +
        `${applyUrl(slug)}\n`;
      break;
    case "denied":
      inboxKind = "application.denied";
      inboxPayload = {
        projectId: app.projectId,
        projectSlug: slug,
        projectName: name,
        reason: reason ?? null,
      };
      subject = `Application declined: ${name}`;
      text =
        `Your application for ${name} was declined.` +
        (reason ? `\n\nReason: ${reason}` : "") +
        `\n\n${applyUrl(slug)}\n`;
      break;
    case "revoked": {
      inboxKind = "application.revoked";
      inboxPayload = {
        projectId: app.projectId,
        projectSlug: slug,
        projectName: name,
        reason: reason ?? null,
        target,
      };
      const followUp =
        target === "PENDING"
          ? `\n\nYou may submit a new application at any time: ${applyUrl(slug)}\n`
          : target === "SUBMITTED"
            ? `\n\nYour application has been put back under review.\n`
            : `\n`;
      subject = `Approval revoked: ${name}`;
      text =
        `Your contributor approval for ${name} has been revoked.` +
        (reason ? `\n\nReason: ${reason}` : "") +
        followUp;
      break;
    }
  }

  // Inbox first (deduped), then email: a retry after an email failure skips
  // the duplicate inbox row and re-attempts the email.
  const payloadStr = JSON.stringify(
    args.dedupKey ? { ...inboxPayload, dedupKey: args.dedupKey } : inboxPayload
  );
  const already = args.dedupKey
    ? await prisma.notification.findFirst({
        where: { userId: app.userId, kind: inboxKind, payload: payloadStr },
        select: { id: true },
      })
    : null;
  if (!already) {
    await prisma.notification.create({
      data: { userId: app.userId, kind: inboxKind, payload: payloadStr },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: app.userId },
    select: { email: true },
  });
  if (user?.email) {
    await sendEmail({ to: user.email, subject, text });
  }
}
