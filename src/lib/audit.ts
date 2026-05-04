import { prisma } from "@/lib/db";

export type AuditKind =
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "member.invited"
  | "member.role_changed"
  | "member.removed"
  | "repo.linked"
  | "repo.unlinked"
  | "repo.opt_out_changed"
  | "form.updated"
  | "settings.updated"
  | "application.submitted"
  | "application.approved"
  | "application.denied"
  | "application.revoked"
  | "application.note_added"
  | "bypass.added"
  | "bypass.removed"
  | "webhook.test_sent"
  | "user.allowlisted"
  | "user.deallowlisted"
  | "settings.gating_changed"
  | "settings.quality_changed"
  | "quality.backfill_started"
  | "quality.backfill_completed"
  | "pr.quality_rescanned"
  | "pr.reevaluate_triggered";

export async function recordAudit(args: {
  projectId: string;
  actorId: string | null;
  kind: AuditKind;
  payload?: Record<string, unknown>;
}) {
  return prisma.auditEvent.create({
    data: {
      projectId: args.projectId,
      actorId: args.actorId,
      kind: args.kind,
      payload: JSON.stringify(args.payload ?? {}),
    },
  });
}
