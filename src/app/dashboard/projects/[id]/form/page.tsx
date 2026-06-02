import { prisma } from "@/lib/db";
import { requireProjectPermission, roleAtLeast } from "@/lib/authz";
import { parseFormSchema } from "@/lib/applications/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { FormBuilder } from "./builder";
import { saveFormSchema, applyTemplate, saveAsTemplate } from "./actions";

export default async function ProjectFormPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { session, role } = await requireProjectPermission(id, "project_form_view");
  const canEdit = roleAtLeast(role, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, formSchema: true },
  });
  if (!project) return null;

  const initial = parseFormSchema(project.formSchema);
  const templates = canEdit
    ? await prisma.formTemplate.findMany({
        where: { ownerId: session.user.id },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Application form</CardTitle>
          <CardDescription>
            {canEdit
              ? "Configure what applicants will fill out on the public landing page. Live preview on the right."
              : "Read-only view of what applicants will fill out on the public landing page."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormBuilder
            projectId={project.id}
            initial={initial}
            action={saveFormSchema}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Templates</CardTitle>
            <CardDescription>
              Apply a saved template (replaces the current schema), or save the
              current schema as a new template.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You don&apos;t have any templates yet. Create one from the{" "}
                <a className="underline" href="/dashboard/templates">
                  Templates
                </a>{" "}
                page.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {templates.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {parseFormSchema(t.schema).length} fields
                      </Badge>
                    </div>
                    <form action={applyTemplate}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="templateId" value={t.id} />
                      <SubmitButton size="sm" variant="outline">
                        Apply
                      </SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <form action={saveAsTemplate} className="flex items-end gap-2 pt-2">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="flex-1 space-y-1">
                <label className="text-xs font-medium" htmlFor="tpl-name">
                  Save current schema as new template
                </label>
                <input
                  id="tpl-name"
                  name="name"
                  placeholder="Template name"
                  className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <SubmitButton variant="outline" size="sm">
                Save as template
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
