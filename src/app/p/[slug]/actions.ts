"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { submitApplication } from "@/lib/applications/lifecycle";
import { notifyAdminsOfNewApplication } from "@/lib/applications/decide";
import { parseFormSchema, type FormSchema } from "@/lib/applications/schema";
import type { ApplyState } from "./apply-form";

function clientIp(headerList: Headers): string {
  const xff = headerList.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headerList.get("x-real-ip") ?? "unknown";
}

function collectAnswers(
  formData: FormData,
  fields: FormSchema
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.type === "checkbox") {
      out[f.id] = formData.get(f.id) !== null;
    } else {
      const v = formData.get(f.id);
      out[f.id] = typeof v === "string" ? v : "";
    }
  }
  return out;
}

export async function applyAction(
  _prev: ApplyState,
  formData: FormData
): Promise<ApplyState> {
  const session = await auth();
  if (!session?.user) {
    return { status: "error", reason: "Sign in with GitHub first." };
  }

  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) {
    return { status: "error", reason: "Missing project." };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true, formSchema: true },
  });
  if (!project) return { status: "error", reason: "Project not found." };

  const fields = parseFormSchema(project.formSchema);
  // Echo what the user submitted on every error path so the form can
  // re-populate without losing input on validation failure.
  const submitted = collectAnswers(formData, fields);

  // Rate limit by user (5/hr) and IP (20/hr).
  const userLimit = await rateLimit({
    key: `apply:user:${session.user.id}`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!userLimit.ok) {
    return {
      status: "error",
      reason: "Too many submissions. Try again later.",
      values: submitted,
    };
  }
  const ip = clientIp(await headers());
  const ipLimit = await rateLimit({
    key: `apply:ip:${ip}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!ipLimit.ok) {
    return {
      status: "error",
      reason: "Too many submissions from your network. Try again later.",
      values: submitted,
    };
  }

  const result = await submitApplication({
    userId: session.user.id,
    projectId: project.id,
    rawAnswers: submitted,
  });

  if (!result.ok) {
    return { status: "error", reason: result.reason, values: submitted };
  }

  await notifyAdminsOfNewApplication({ applicationId: result.applicationId });

  revalidatePath(`/p/${project.slug}`);
  return { status: "ok", applicationId: result.applicationId };
}
