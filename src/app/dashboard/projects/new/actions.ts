"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { createProject } from "@/lib/projects";
import { slugSchema, slugify } from "@/lib/slug";

const inputSchema = z.object({
  name: z.string().min(2).max(80),
  slug: slugSchema,
  description: z.string().max(500).optional(),
});

export type CreateProjectState = {
  error?: string;
  values?: { name?: string; slug?: string; description?: string };
};

export async function createProjectAction(
  _prev: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  const session = await auth();
  if (!session?.user) return { error: "Not signed in" };
  if (!session.user.canCreateProj) return { error: "Not authorized to create projects" };

  const raw = {
    name: String(formData.get("name") ?? "").trim(),
    slug: String(formData.get("slug") ?? slugify(String(formData.get("name") ?? ""))).trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
  };

  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      values: raw,
    };
  }

  const existing = await prisma.project.findUnique({
    where: { slug: parsed.data.slug },
    select: { id: true },
  });
  if (existing) {
    return { error: `Slug "${parsed.data.slug}" is already taken.`, values: raw };
  }

  const project = await createProject({
    ownerId: session.user.id,
    slug: parsed.data.slug,
    name: parsed.data.name,
    description: parsed.data.description,
  });

  redirect(`/dashboard/projects/${project.id}`);
}
