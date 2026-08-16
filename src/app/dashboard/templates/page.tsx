import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { SiteHeader } from "@/components/site-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";
import { parseFormSchema } from "@/lib/applications/schema";
import { formatDate } from "@/lib/ui/format";
import { createTemplate, deleteTemplate } from "./actions";

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamRecord>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const { page, perPage, skip, take, q } = parsePageParams(sp);

  const where = {
    ownerId: session.user.id,
    ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
  };

  const [templates, total] = await prisma.$transaction([
    prisma.formTemplate.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.formTemplate.count({ where }),
  ]);

  const basePath = "/dashboard/templates";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-semibold">Form templates</h1>
          <p className="text-sm text-muted-foreground">
            Reusable form schemas that you can apply to any of your projects.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">New template</CardTitle>
            <CardDescription>
              Paste a JSON form schema (the same structure as the Form tab).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createTemplate} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" placeholder="Default 3-question form" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schema">Schema JSON</Label>
                <Textarea
                  id="schema"
                  name="schema"
                  rows={6}
                  required
                  placeholder='[{"id":"motivation","type":"textarea","label":"Why?","required":true}]'
                  className="font-mono text-xs"
                />
              </div>
              <SubmitButton>Save template</SubmitButton>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your templates</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="border-b border-border px-6 py-3">
              <SearchInput
                pathname={basePath}
                q={q}
                placeholder="Search by name"
              />
            </div>
            {templates.length === 0 ? (
              <div className="px-6 py-6 text-sm text-muted-foreground">
                {q ? "No templates match your search." : "No templates yet."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {templates.map((t) => {
                  const fields = parseFormSchema(t.schema);
                  return (
                    <li key={t.id} className="px-6 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{t.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {fields.length} field{fields.length === 1 ? "" : "s"} ·{" "}
                            {formatDate(t.createdAt)}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {fields.slice(0, 4).map((f) => (
                            <Badge key={f.id} variant="outline" className="text-[10px]">
                              {f.type}
                            </Badge>
                          ))}
                          <form action={deleteTemplate}>
                            <input type="hidden" name="templateId" value={t.id} />
                            <SubmitButton
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:bg-destructive/10"
                            >
                              Delete
                            </SubmitButton>
                          </form>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination
              pathname={basePath}
              searchParams={sp}
              page={page}
              perPage={perPage}
              total={total}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
