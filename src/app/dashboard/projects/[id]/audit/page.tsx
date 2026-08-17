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
import { formatDateTimeSeconds } from "@/lib/ui/format";
import { CodeBlock } from "@/components/code-block";
import { EmptyState } from "@/components/empty-state";

/**
 * Pretty-print an audit payload for display. The column is a plain JSON string
 * with no schema, so a malformed row must not take the page down: this used to
 * be a bare JSON.parse inside JSX, which throws during render.
 */
function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}


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
          <EmptyState
            variant="row"
            query={q}
            clearHref={basePath}
            title="No audit events yet"
            description="Approvals, denials and settings changes are recorded here."
          />
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
                    {formatDateTimeSeconds(e.createdAt)}
                  </time>
                </div>
                {e.payload !== "{}" && (
                  <CodeBlock
                    className="mt-2"
                    language="payload"
                    maxHeight="16rem"
                    code={prettyPayload(e.payload)}
                  />
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
