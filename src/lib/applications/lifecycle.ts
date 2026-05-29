import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { buildAnswersSchema, parseFormSchema } from "@/lib/applications/schema";

export type SubmitResult =
  | { ok: true; applicationId: string }
  | { ok: false; reason: string; cooldownUntil?: Date };

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
