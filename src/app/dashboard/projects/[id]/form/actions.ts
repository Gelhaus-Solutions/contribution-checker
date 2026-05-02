"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { formSchema as zFormSchema } from "@/lib/applications/schema";

const inputSchema = z.object({
  projectId: z.string().min(1),
  schema: z.string(),
});

export async function saveFormSchema(formData: FormData) {
  const parsed = inputSchema.parse({
    projectId: formData.get("projectId"),
    schema: formData.get("schema"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  let parsedSchema;
  try {
    parsedSchema = zFormSchema.parse(JSON.parse(parsed.schema));
  } catch (e) {
    throw new Error(
      `Invalid form schema: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Enforce unique field IDs.
  const ids = new Set<string>();
  for (const f of parsedSchema) {
    if (ids.has(f.id)) {
      throw new Error(`Duplicate field id: "${f.id}"`);
    }
    ids.add(f.id);
  }

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: { formSchema: JSON.stringify(parsedSchema) },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "form.updated",
    payload: { fieldCount: parsedSchema.length },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/form`);
  revalidatePath(`/p/[slug]`);
}

const applySchema = z.object({
  projectId: z.string().min(1),
  templateId: z.string().min(1),
});

export async function applyTemplate(formData: FormData) {
  const parsed = applySchema.parse({
    projectId: formData.get("projectId"),
    templateId: formData.get("templateId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const template = await prisma.formTemplate.findUnique({
    where: { id: parsed.templateId },
  });
  if (!template || template.ownerId !== session.user.id) {
    throw new Error("Template not found");
  }
  // Re-validate to be safe.
  const fields = zFormSchema.parse(JSON.parse(template.schema));

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: {
      formSchema: JSON.stringify(fields),
      templateId: template.id,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "form.updated",
    payload: { templateId: template.id, templateName: template.name },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/form`);
}

const saveAsSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(2).max(80),
});

export async function saveAsTemplate(formData: FormData) {
  const parsed = saveAsSchema.parse({
    projectId: formData.get("projectId"),
    name: String(formData.get("name") ?? "").trim(),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: { formSchema: true },
  });
  if (!project) throw new Error("Project not found");

  await prisma.formTemplate.create({
    data: {
      ownerId: session.user.id,
      name: parsed.name,
      schema: project.formSchema,
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/form`);
  revalidatePath("/dashboard/templates");
}

