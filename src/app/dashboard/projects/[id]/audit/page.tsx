import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireProjectPermission } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";

export default async function AuditLog({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireProjectPermission(id, "project_audit_view");

  const { page, perPage, skip, take, q } = parsePageParams(sp);

  const where: Prisma.AuditEventWhereInput = {
    projectId: id,
    ...(q
      ? {
          OR: [
            { kind: { contains: q, mode: "insensitive" } },
            { actor: { ghLogin: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [events, total] = await prisma.$transaction([
    prisma.auditEvent.findMany({
      where,
      include: { actor: { select: { ghLogin: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.auditEvent.count({ where }),
  ]);

  const basePath = `/dashboard/projects/${id}/audit`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>
          {total} event{total === 1 ? "" : "s"} recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-b border-border px-6 py-3">
          <SearchInput
            pathname={basePath}
            q={q}
            placeholder="Search by kind or actor"
          />
        </div>
        {events.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted-foreground">
            {q ? "No events match your search." : "No events yet."}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="px-6 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{e.kind}</Badge>
                    <span className="text-muted-foreground">
                      by {e.actor?.ghLogin ?? "system"}
                    </span>
                  </div>
                  <time className="text-xs text-muted-foreground">
                    {e.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </time>
                </div>
                {e.payload !== "{}" && (
                  <pre className="mt-2 overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
                    {JSON.stringify(JSON.parse(e.payload), null, 2)}
                  </pre>
                )}
              </li>
            ))}
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
  );
}
