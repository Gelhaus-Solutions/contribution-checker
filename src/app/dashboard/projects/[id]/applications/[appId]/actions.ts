"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole, requireSession, getProjectMembership, roleAtLeast, type Role } from "@/lib/authz";
import {
  approveApplication,
  denyApplication,
  revokeApplication,
  allowApplicationResubmit,
  resolveAppeal,
  ApprovalGateError,
  ClaGateError,
} from "@/lib/applications/decide";
import {
  dispatchContributorDecision,
  refreshContributorCooldown,
} from "@/lib/temporal/start";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers, notifyUser } from "@/lib/notifications/inbox";
import {
  submitReviewSchema,
  fieldCommentSchema,
  editNoteSchema,
  deleteNoteSchema,
  replyToCommentSchema,
  dismissReviewSchema,
  visibilityForReviewState,
} from "@/lib/applications/schema";

const baseSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

async function ensureApplicationInProject(projectId: string, appId: string) {
  const app = await prisma.application.findUnique({
    where: { id: appId },
    select: { id: true, projectId: true, status: true, userId: true },
  });
  if (!app || app.projectId !== projectId) {
    throw new Error("Application not found");
  }
  return app;
}

export async function approveAction(formData: FormData) {
  const parsed = baseSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "SUBMITTED" && app.status !== "DENIED") {
    throw new Error(`Cannot approve an application with status ${app.status}.`);
  }

  try {
    await approveApplication({
      applicationId: parsed.appId,
      decidedById: session.user.id,
      reason: parsed.reason,
    });
  } catch (e) {
    if (e instanceof ApprovalGateError) {
      // Surface a friendly message; UI also disables the button proactively.
      throw new Error(
        `Approval gate: this project requires ${e.required} approving review${
          e.required === 1 ? "" : "s"
        } from other reviewers (currently ${e.have}).`,
      );
    }
    if (e instanceof ClaGateError) {
      // Same contract as the approval gate: the approve button is disabled
      // proactively in the UI, and this is the server-side safety net so the
      // raw error never reaches the global error boundary.
      throw new Error(
        "CLA gate: this applicant must sign the project's Contributor License Agreement before they can be approved.",
      );
    }
    throw e;
  }

  await dispatchContributorDecision("approved", parsed.appId);

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

const denySchema = baseSchema.extend({
  allowResubmit: z
    .union([z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")])
    .optional(),
});

export async function denyAction(formData: FormData) {
  const parsed = denySchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
    allowResubmit: formData.get("allowResubmit") ?? undefined,
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "SUBMITTED") {
    throw new Error(`Cannot deny an application with status ${app.status}.`);
  }

  const allowResubmit =
    parsed.allowResubmit === "on" ||
    parsed.allowResubmit === "true" ||
    parsed.allowResubmit === "1";

  await denyApplication({
    applicationId: parsed.appId,
    decidedById: session.user.id,
    reason: parsed.reason,
    allowResubmit,
  });

  await dispatchContributorDecision("denied", parsed.appId);

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

/**
 * Re-open resubmission on a DENIED application that was denied with
 * "allow resubmitting" off. Same gate as denying (REVIEWER): softening a denial
 * is no more privileged than issuing one.
 */
export async function allowResubmitAction(formData: FormData) {
  const parsed = baseSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "DENIED") {
    throw new Error(`Cannot allow resubmitting on an application with status ${app.status}.`);
  }

  await allowApplicationResubmit({
    applicationId: parsed.appId,
    decidedById: session.user.id,
  });

  // No GitHub fan-out (the app stays DENIED), but the cooldown was (re)set:
  // have the contributor entity (re)arm its durable timer.
  await refreshContributorCooldown(parsed.appId);

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
  const slug = await projectSlug(parsed.projectId);
  if (slug) revalidatePath(`/p/${slug}`);
}

const revokeSchema = baseSchema.extend({
  target: z.enum(["DENIED", "SUBMITTED", "PENDING"]).default("DENIED"),
});

export async function revokeAction(formData: FormData) {
  const parsed = revokeSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
    target: formData.get("target") ?? "DENIED",
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);
  if (app.status !== "APPROVED") {
    throw new Error(`Cannot revoke an application with status ${app.status}.`);
  }

  await revokeApplication({
    applicationId: parsed.appId,
    decidedById: session.user.id,
    reason: parsed.reason,
    target: parsed.target,
  });

  await dispatchContributorDecision("revoked", parsed.appId, {
    reason: parsed.reason,
    target: parsed.target,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

const resolveAppealSchema = baseSchema.extend({
  resolution: z.enum(["GRANT", "ALLOW_RESUBMIT", "REJECT"]),
});

/**
 * Resolve a pending appeal. Same REVIEWER gate as approve/deny. GRANT reuses
 * approveApplication (subject to the approval-count / CLA gates, translated
 * here just like approveAction) and then reopens prior closed PRs via
 * onApplicationApproved. ALLOW_RESUBMIT / REJECT do not reopen PRs.
 */
export async function resolveAppealAction(formData: FormData) {
  const parsed = resolveAppealSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reason: String(formData.get("reason") ?? "").trim() || undefined,
    resolution: formData.get("resolution"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  try {
    await resolveAppeal({
      applicationId: parsed.appId,
      resolution: parsed.resolution,
      resolvedById: session.user.id,
      note: parsed.reason,
    });
  } catch (e) {
    if (e instanceof ApprovalGateError) {
      throw new Error(
        `Approval gate: this project requires ${e.required} approving review${
          e.required === 1 ? "" : "s"
        } from other reviewers (currently ${e.have}).`,
      );
    }
    if (e instanceof ClaGateError) {
      throw new Error(
        "CLA gate: this applicant must sign the project's Contributor License Agreement before the appeal can be granted.",
      );
    }
    throw e;
  }

  if (parsed.resolution === "GRANT") {
    await dispatchContributorDecision("approved", parsed.appId);
  }

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
  const slug = await projectSlug(parsed.projectId);
  if (slug) revalidatePath(`/p/${slug}`);
}

const noteSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  body: z.string().min(1).max(2000),
});

export async function addNoteAction(formData: FormData) {
  const parsed = noteSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    body: String(formData.get("body") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  await prisma.applicationNote.create({
    data: {
      applicationId: parsed.appId,
      authorId: session.user.id,
      body: parsed.body,
    },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.note_added",
    payload: { applicationId: parsed.appId },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/applications/${parsed.appId}`);
}

// ---- Review-process actions ------------------------------------------------

function reviewerPaths(projectId: string, appId: string, slug?: string | null) {
  revalidatePath(`/dashboard/projects/${projectId}/applications`);
  revalidatePath(`/dashboard/projects/${projectId}/applications/${appId}`);
  if (slug) revalidatePath(`/p/${slug}`);
}

/**
 * Submit a review (Approve / Request Changes / Comment) and link any draft
 * per-field comments authored by the same reviewer. Visibility on linked
 * comments is normalized from the review state; the reviewer only chooses
 * visibility for the COMMENTED state.
 */
export async function submitReviewAction(formData: FormData) {
  const draftIds = formData
    .getAll("draftCommentIds")
    .map((v) => String(v))
    .filter(Boolean);
  const parsed = submitReviewSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    state: formData.get("state"),
    body: String(formData.get("body") ?? "").trim(),
    visibility: formData.get("visibility")
      ? String(formData.get("visibility"))
      : undefined,
    draftCommentIds: draftIds,
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);

  const visibility = visibilityForReviewState(parsed.state, parsed.visibility);

  const review = await prisma.$transaction(async (tx) => {
    const r = await tx.applicationReview.create({
      data: {
        applicationId: parsed.appId,
        authorId: session.user.id,
        state: parsed.state,
        body: parsed.body || null,
        visibility,
      },
    });
    if (parsed.draftCommentIds.length > 0) {
      // Only link drafts that this reviewer actually owns and that aren't
      // already attached to a review or deleted. Other ids are silently
      // ignored; defends against tampered form payloads.
      await tx.applicationNote.updateMany({
        where: {
          id: { in: parsed.draftCommentIds },
          applicationId: parsed.appId,
          authorId: session.user.id,
          reviewId: null,
          deletedAt: null,
        },
        data: { reviewId: r.id, visibility },
      });
    }
    return r;
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.review_submitted",
    payload: {
      applicationId: parsed.appId,
      reviewId: review.id,
      state: parsed.state,
      visibility,
    },
  });

  if (visibility === "APPLICANT") {
    await notifyUser({
      userId: app.userId,
      kind: "application.review_submitted",
      payload: {
        applicationId: parsed.appId,
        reviewId: review.id,
        state: parsed.state,
        projectId: parsed.projectId,
      },
    });
  } else {
    await notifyProjectReviewers({
      projectId: parsed.projectId,
      excludeUserId: session.user.id,
      kind: "application.review_submitted",
      payload: {
        applicationId: parsed.appId,
        reviewId: review.id,
        state: parsed.state,
        projectId: parsed.projectId,
      },
    });
  }

  reviewerPaths(parsed.projectId, parsed.appId, await projectSlug(parsed.projectId));
}

/**
 * Create a draft per-field comment. Stays unattached (reviewId=null) until
 * the reviewer submits a review; visibility starts INTERNAL and is
 * normalized at submit-time.
 */
export async function addFieldCommentAction(formData: FormData) {
  const parsed = fieldCommentSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    fieldId: formData.get("fieldId"),
    body: String(formData.get("body") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "REVIEWER");
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  await prisma.applicationNote.create({
    data: {
      applicationId: parsed.appId,
      authorId: session.user.id,
      fieldId: parsed.fieldId,
      body: parsed.body,
      visibility: "INTERNAL",
    },
  });

  reviewerPaths(parsed.projectId, parsed.appId);
}

export async function editNoteAction(formData: FormData) {
  const parsed = editNoteSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    noteId: formData.get("noteId"),
    body: String(formData.get("body") ?? "").trim(),
  });
  const session = await requireSession();
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);

  const note = await prisma.applicationNote.findUnique({
    where: { id: parsed.noteId },
    select: {
      authorId: true,
      applicationId: true,
      deletedAt: true,
    },
  });
  if (!note || note.applicationId !== parsed.appId) {
    throw new Error("Note not found");
  }
  if (note.deletedAt) throw new Error("Cannot edit a deleted comment");
  if (note.authorId !== session.user.id) {
    throw new Error("You can only edit your own comments");
  }
  // Authorize: must either be a project member with REVIEWER+ OR be the
  // applicant editing their own reply (replies authored by applicant on
  // applicant-visible threads).
  const membership = await getProjectMembership(parsed.projectId, session.user.id);
  const isApplicant = session.user.id === app.userId;
  if (!membership && !isApplicant) {
    throw new Error("Forbidden");
  }
  if (membership && !roleAtLeast(membership.role as Role, "REVIEWER") && !isApplicant) {
    throw new Error("Forbidden");
  }

  await prisma.applicationNote.update({
    where: { id: parsed.noteId },
    data: { body: parsed.body },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.note_edited",
    payload: { applicationId: parsed.appId, noteId: parsed.noteId },
  });

  reviewerPaths(parsed.projectId, parsed.appId, await projectSlug(parsed.projectId));
}

/**
 * Soft-delete a note. Author always; project ADMIN may delete anyone's note
 * (e.g. moderation). Sets deletedAt so child threads stay coherent.
 */
export async function deleteNoteAction(formData: FormData) {
  const parsed = deleteNoteSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    noteId: formData.get("noteId"),
  });
  const session = await requireSession();
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  const note = await prisma.applicationNote.findUnique({
    where: { id: parsed.noteId },
    select: { authorId: true, applicationId: true, deletedAt: true },
  });
  if (!note || note.applicationId !== parsed.appId) {
    throw new Error("Note not found");
  }
  if (note.deletedAt) return; // idempotent

  const isAuthor = note.authorId === session.user.id;
  let isAdmin = false;
  if (!isAuthor) {
    const membership = await getProjectMembership(parsed.projectId, session.user.id);
    isAdmin = !!membership && roleAtLeast(membership.role as Role, "ADMIN");
  }
  if (!isAuthor && !isAdmin) {
    throw new Error("Forbidden");
  }

  await prisma.applicationNote.update({
    where: { id: parsed.noteId },
    data: { deletedAt: new Date() },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.note_deleted",
    payload: {
      applicationId: parsed.appId,
      noteId: parsed.noteId,
      byAdmin: isAdmin,
    },
  });

  reviewerPaths(parsed.projectId, parsed.appId, await projectSlug(parsed.projectId));
}

/**
 * Reply to an existing comment. Project reviewers can reply on any thread.
 * The applicant can reply *only* when the parent comment is APPLICANT-
 * visible: that's the conversation channel for "Request Changes" reviews.
 * The reply inherits the parent's visibility so the thread stays coherent.
 */
export async function replyToCommentAction(formData: FormData) {
  const parsed = replyToCommentSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    parentId: formData.get("parentId"),
    body: String(formData.get("body") ?? "").trim(),
  });
  const session = await requireSession();
  const app = await ensureApplicationInProject(parsed.projectId, parsed.appId);

  const parent = await prisma.applicationNote.findUnique({
    where: { id: parsed.parentId },
    select: {
      applicationId: true,
      visibility: true,
      fieldId: true,
      reviewId: true,
      deletedAt: true,
    },
  });
  if (!parent || parent.applicationId !== parsed.appId) {
    throw new Error("Parent comment not found");
  }
  if (parent.deletedAt) throw new Error("Cannot reply to a deleted comment");

  const membership = await getProjectMembership(parsed.projectId, session.user.id);
  const isReviewer =
    !!membership && roleAtLeast(membership.role as Role, "REVIEWER");
  const isApplicant = session.user.id === app.userId;
  const applicantAllowed = isApplicant && parent.visibility === "APPLICANT";
  if (!isReviewer && !applicantAllowed) {
    throw new Error("Forbidden");
  }

  await prisma.applicationNote.create({
    data: {
      applicationId: parsed.appId,
      authorId: session.user.id,
      parentId: parsed.parentId,
      fieldId: parent.fieldId,
      reviewId: parent.reviewId,
      visibility: parent.visibility,
      body: parsed.body,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.comment_replied",
    payload: {
      applicationId: parsed.appId,
      parentId: parsed.parentId,
      byApplicant: isApplicant && !isReviewer,
    },
  });

  // Notification routing: applicant→reviewers, reviewer→applicant (only on
  // applicant-visible threads; reviewer-internal replies don't notify the
  // applicant).
  if (isApplicant && !isReviewer) {
    await notifyProjectReviewers({
      projectId: parsed.projectId,
      excludeUserId: session.user.id,
      kind: "application.comment_replied",
      payload: {
        applicationId: parsed.appId,
        parentId: parsed.parentId,
        projectId: parsed.projectId,
      },
    });
  } else if (parent.visibility === "APPLICANT" && app.userId !== session.user.id) {
    await notifyUser({
      userId: app.userId,
      kind: "application.comment_replied",
      payload: {
        applicationId: parsed.appId,
        parentId: parsed.parentId,
        projectId: parsed.projectId,
      },
    });
  }

  reviewerPaths(parsed.projectId, parsed.appId, await projectSlug(parsed.projectId));
}

/**
 * Soft-dismiss a review so it no longer counts toward the approval gate.
 * Mirrors GitHub's "dismiss review": the review row stays for audit but
 * is excluded from the LGTM count.
 */
export async function dismissReviewAction(formData: FormData) {
  const parsed = dismissReviewSchema.parse({
    projectId: formData.get("projectId"),
    appId: formData.get("appId"),
    reviewId: formData.get("reviewId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");
  await ensureApplicationInProject(parsed.projectId, parsed.appId);

  const review = await prisma.applicationReview.findUnique({
    where: { id: parsed.reviewId },
    select: { applicationId: true, deletedAt: true },
  });
  if (!review || review.applicationId !== parsed.appId) {
    throw new Error("Review not found");
  }
  if (review.deletedAt) return;

  await prisma.applicationReview.update({
    where: { id: parsed.reviewId },
    data: { deletedAt: new Date() },
  });
  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "application.review_dismissed",
    payload: { applicationId: parsed.appId, reviewId: parsed.reviewId },
  });

  reviewerPaths(parsed.projectId, parsed.appId);
}

async function projectSlug(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { slug: true },
  });
  return p?.slug ?? null;
}
