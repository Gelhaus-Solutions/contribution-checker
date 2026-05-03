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
}): Promise<SubmitResult> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { id: true, formSchema: true },
  });
  if (!project) return { ok: false, reason: "Project not found" };

  // Validate answers against the current form schema.
  const fields = parseFormSchema(project.formSchema);
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

  // Lookup most-recent application from this user for this project.
  const last = await prisma.application.findFirst({
    where: { projectId: args.projectId, userId: args.userId },
    orderBy: { createdAt: "desc" },
  });

  if (last) {
    if (last.status === "SUBMITTED") {
      return { ok: false, reason: "You already have a pending application." };
    }
    if (last.status === "APPROVED") {
      return { ok: false, reason: "You already have an approved application." };
    }
    if (last.status === "DENIED") {
      if (!last.allowResubmit) {
        return {
          ok: false,
          reason:
            "Your previous application was denied. The project owner must reset your status before you can re-apply.",
        };
      }
      if (last.cooldownUntil && last.cooldownUntil > new Date()) {
        return {
          ok: false,
          reason: `You are in a cooldown period after a denial.`,
          cooldownUntil: last.cooldownUntil,
        };
      }
    }
  }

  const application = await prisma.application.create({
    data: {
      projectId: args.projectId,
      userId: args.userId,
      answers: JSON.stringify(parsed.data),
      status: "SUBMITTED",
    },
  });

  await recordAudit({
    projectId: args.projectId,
    actorId: args.userId,
    kind: "application.submitted",
    payload: { applicationId: application.id },
  });

  return { ok: true, applicationId: application.id };
}
