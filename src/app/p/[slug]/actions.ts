"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { submitApplication } from "@/lib/applications/lifecycle";
import { notifyAdminsOfNewApplication } from "@/lib/applications/decide";
import { parseFormSchema } from "@/lib/applications/schema";
import type { ApplyState } from "./apply-form";

function clientIp(headerList: Headers): string {
  const xff = headerList.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headerList.get("x-real-ip") ?? "unknown";
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
    };
  }

  // Build raw answers from FormData based on the project's current form schema.
  const fields = parseFormSchema(project.formSchema);
  const raw: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "checkbox") {
      raw[f.id] = formData.get(f.id) !== null;
    } else {
      const v = formData.get(f.id);
      raw[f.id] = typeof v === "string" ? v : "";
    }
  }

  const result = await submitApplication({
    userId: session.user.id,
    projectId: project.id,
    rawAnswers: raw,
  });

  if (!result.ok) {
    return { status: "error", reason: result.reason };
  }

  await notifyAdminsOfNewApplication({ applicationId: result.applicationId });

  revalidatePath(`/p/${project.slug}`);
  return { status: "ok", applicationId: result.applicationId };
}
