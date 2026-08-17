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
  | "application.resubmit_allowed"
  | "application.appeal_submitted"
  | "application.appeal_resolved"
  | "application.revoked"
  | "application.note_added"
  | "application.note_edited"
  | "application.note_deleted"
  | "application.review_submitted"
  | "application.review_dismissed"
  | "application.comment_replied"
  | "bypass.added"
  | "bypass.removed"
  | "webhook.test_sent"
  | "user.allowlisted"
  | "user.deallowlisted"
  | "settings.gating_changed"
  | "settings.staging_changed"
  | "settings.quality_changed"
  | "quality.backfill_started"
  | "quality.backfill_completed"
  | "pr.quality_rescanned"
  | "pr.reevaluate_triggered"
  | "cla.settings_changed"
  | "cla.version_published"
  | "cla.version_resign_changed"
  | "cla.pending_change_detected"
  | "cla.pending_change_approved"
  | "cla.pending_change_rejected"
  | "cla.repo_sync_run"
  | "cla.signed"
  | "cla.ccla_signed"
  | "cla.ccla_approved"
  | "cla.ccla_rejected"
  | "cla.signature_revoked"
  | "cla.roster_added"
  | "cla.roster_revoked"
  | "cla.roster_disputed"
  | "cla.waiver_granted"
  | "cla.waiver_revoked"
  | "cla.signatures_exported"
  | "cla.notify_unsigned_started"
  | "cla.notify_unsigned_completed"
  // Stack Auth (Hexclave) teams/permissions migration
  | "team.provisioned"
  | "team.provision_failed"
  | "team.reconciled"
  | "member.permission_granted"
  | "member.permission_revoked"
  // App-level (projectId may be null)
  | "stack.permissions_provisioned"
  | "instance_admins_seeded"
  | "user.superadmin_granted"
  | "user.superadmin_revoked"
  | "vault.resolution_failed"
  | "vault.cache_invalidated"
  // Temporal durable execution
  | "application.cooldown_elapsed"
  | "workflow.failed";

export async function recordAudit(args: {
  // Null = app-level event not tied to a project (e.g. Vault failures).
  projectId: string | null;
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
