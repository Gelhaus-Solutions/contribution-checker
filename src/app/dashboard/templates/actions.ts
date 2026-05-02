"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { formSchema as zFormSchema } from "@/lib/applications/schema";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  schema: z.string(),
});

export async function createTemplate(formData: FormData) {
  const session = await requireSession();
  const parsed = createSchema.parse({
    name: String(formData.get("name") ?? "").trim(),
    schema: formData.get("schema"),
  });

  let parsedSchema;
  try {
    parsedSchema = zFormSchema.parse(JSON.parse(parsed.schema));
  } catch (e) {
    throw new Error(
      `Invalid schema: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  await prisma.formTemplate.create({
    data: {
      ownerId: session.user.id,
      name: parsed.name,
      schema: JSON.stringify(parsedSchema),
    },
  });

  revalidatePath("/dashboard/templates");
}

const idSchema = z.object({ templateId: z.string().min(1) });

export async function deleteTemplate(formData: FormData) {
  const session = await requireSession();
  const { templateId } = idSchema.parse({
    templateId: formData.get("templateId"),
  });

  const tpl = await prisma.formTemplate.findUnique({
    where: { id: templateId },
    select: { ownerId: true },
  });
  if (!tpl || tpl.ownerId !== session.user.id) {
    throw new Error("Template not found");
  }

  await prisma.formTemplate.delete({ where: { id: templateId } });

  revalidatePath("/dashboard/templates");
}
