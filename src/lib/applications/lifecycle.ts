import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { buildAnswersSchema, parseFormSchema } from "@/lib/applications/schema";

export type SubmitResult =
  | { ok: true; applicationId: string }
  | { ok: false; reason: string; cooldownUntil?: Date };

export type AppealResult =
  | { ok: true; appealId: string }
  | { ok: false; reason: string };

/**
 * Whether the (project, user) pair has a manual DENIED decision. A manual
 * DENIED already hard-blocks the user's PRs (decide-pr.ts); we treat it as
 * "blocked" for application + appeal submission too. CLA signing is a separate
 * flow and is intentionally unaffected. Manual decisions are keyed by lowercase
 * ghLogin; users with no linked GitHub login can't be the subject of one.
 */
export async function isManuallyBlocked(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ghLogin: true },
  });
  if (!user?.ghLogin) return false;
  const manual = await prisma.manualDecision.findUnique({
    where: {
      projectId_ghLogin: { projectId, ghLogin: user.ghLogin.toLowerCase() },
    },
    select: { status: true },
  });
  return manual?.status === "DENIED";
}

export async function submitApplication(args: {
  userId: string;
  projectId: string;
  rawAnswers: Record<string, unknown>;
  /**
   * Optional caller-owned transaction. When supplied, the Application row is
   * created inside this transaction so callers can atomically write related
   * rows (e.g. an embedded CLA signature). When omitted, a plain create is
   * used as before.
   */
  tx?: Prisma.TransactionClient;
  /**
   * Optional hook run inside the same transaction immediately after the
   * Application is created. Only invoked when `tx` is supplied. Throwing from
   * here rolls back the application create. Used by the apply flow to record
   * the embedded ClaSignature atomically with the application.
   */
  afterCreate?: (
    application: { id: string },
    tx: Prisma.TransactionClient
  ) => Promise<void>;
}): Promise<SubmitResult> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { id: true, slug: true, formSchema: true },
  });
  if (!project) {
    Sentry.metrics.count("application.submit", 1, {
      attributes: { outcome: "project_not_found" },
    });
    return { ok: false, reason: "Project not found" };
  }

  // Validate answers against the current form schema.
  const fields = parseFormSchema(project.formSchema);
  const answersSchema = buildAnswersSchema(fields);
  const parsed = answersSchema.safeParse(args.rawAnswers);
  if (!parsed.success) {
    Sentry.metrics.count("application.submit", 1, {
      attributes: {
        outcome: "validation_failed",
        "project.id": project.id,
        "project.slug": project.slug,
      },
    });
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }

  // Lookup most-recent application from this user for this project.
  const last = await prisma.application.findFirst({
    where: { projectId: args.projectId, userId: args.userId },
    orderBy: { createdAt: "desc" },
    include: { appeal: { select: { status: true } } },
  });

  const blockMetric = (reason: string) =>
    Sentry.metrics.count("application.submit", 1, {
      attributes: {
        outcome: "blocked",
        "block.reason": reason,
        "project.id": project.id,
        "project.slug": project.slug,
      },
    });

  // A manually DENIED contributor cannot apply at all (mirrors decide-pr.ts).
  if (await isManuallyBlocked(args.projectId, args.userId)) {
    blockMetric("manual_blocked");
    return {
      ok: false,
      reason: "You are not eligible to apply to this project.",
    };
  }

  if (last) {
    if (last.status === "SUBMITTED") {
      blockMetric("pending_application_exists");
      return { ok: false, reason: "You already have a pending application." };
    }
    if (last.status === "APPROVED") {
      blockMetric("already_approved");
      return { ok: false, reason: "You already have an approved application." };
    }
    if (last.status === "DENIED") {
      if (last.appeal?.status === "PENDING") {
        blockMetric("appeal_pending");
        return {
          ok: false,
          reason:
            "You have an appeal under review; you cannot submit a new application until it is resolved.",
        };
      }
      if (!last.allowResubmit) {
        blockMetric("resubmit_disabled");
        return {
          ok: false,
          reason:
            "Your previous application was denied. The project owner must reset your status before you can re-apply.",
        };
      }
      if (last.cooldownUntil && last.cooldownUntil > new Date()) {
        blockMetric("cooldown_active");
        return {
          ok: false,
          reason: `You are in a cooldown period after a denial.`,
          cooldownUntil: last.cooldownUntil,
        };
      }
    }
  }

  const applicationData = {
    projectId: args.projectId,
    userId: args.userId,
    answers: JSON.stringify(parsed.data),
    status: "SUBMITTED",
  };
  const application = args.tx
    ? await (async () => {
        const tx = args.tx!;
        const created = await tx.application.create({ data: applicationData });
        if (args.afterCreate) await args.afterCreate(created, tx);
        return created;
      })()
    : await prisma.application.create({ data: applicationData });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.userId,
    kind: "application.submitted",
    payload: { applicationId: application.id },
  });

  Sentry.metrics.count("application.submit", 1, {
    attributes: {
      outcome: "ok",
      "project.id": project.id,
      "project.slug": project.slug,
      "application.is_resubmit": Boolean(last),
    },
  });

  return { ok: true, applicationId: application.id };
}

/** Max length for an appeal message (mirrors the note body cap). */
const APPEAL_MESSAGE_MAX = 4000;

/**
 * File an appeal against a DENIED application: a free-text message plus revised
 * answers, validated against the project's current form schema. Exactly one
 * appeal per application (DB-enforced). The reviewer-facing notify/email/webhook
 * is left to the action layer (see appealAction -> notifyAdminsOfAppeal),
 * mirroring how submitApplication pairs with notifyAdminsOfNewApplication.
 */
export async function submitAppeal(args: {
  userId: string;
  applicationId: string;
  message: string;
  rawAnswers: Record<string, unknown>;
}): Promise<AppealResult> {
  const app = await prisma.application.findUnique({
    where: { id: args.applicationId },
    include: {
      project: {
        select: { id: true, slug: true, name: true, formSchema: true, allowAppeals: true },
      },
      appeal: { select: { id: true } },
    },
  });
  if (!app) return { ok: false, reason: "Application not found." };
  if (app.userId !== args.userId) {
    return { ok: false, reason: "This is not your application." };
  }
  if (!app.project.allowAppeals) {
    return { ok: false, reason: "Appeals are not enabled for this project." };
  }
  if (app.status !== "DENIED") {
    return { ok: false, reason: "Only a denied application can be appealed." };
  }
  if (app.appeal) {
    return { ok: false, reason: "You have already appealed this decision." };
  }
  if (await isManuallyBlocked(app.projectId, args.userId)) {
    return { ok: false, reason: "You are not eligible to appeal." };
  }

  const message = args.message.trim();
  if (message.length < 1) {
    return { ok: false, reason: "An appeal message is required." };
  }
  if (message.length > APPEAL_MESSAGE_MAX) {
    return {
      ok: false,
      reason: `Your appeal message is too long (max ${APPEAL_MESSAGE_MAX} characters).`,
    };
  }

  // Validate revised answers against the CURRENT form schema (same as a fresh
  // submission), so an appeal can't smuggle in fields the form no longer has.
  const fields = parseFormSchema(app.project.formSchema);
  const answersSchema = buildAnswersSchema(fields);
  const parsed = answersSchema.safeParse(args.rawAnswers);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }

  const appeal = await prisma.applicationAppeal.create({
    data: {
      applicationId: app.id,
      projectId: app.projectId,
      message,
      answers: JSON.stringify(parsed.data),
      status: "PENDING",
    },
  });

  await recordAudit({
    projectId: app.projectId,
    actorId: args.userId,
    kind: "application.appeal_submitted",
    payload: { applicationId: app.id, appealId: appeal.id },
  });

  return { ok: true, appealId: appeal.id };
}
