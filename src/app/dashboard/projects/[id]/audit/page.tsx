import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AuditLog({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const events = await prisma.auditEvent.findMany({
    where: { projectId: id },
    include: { actor: { select: { ghLogin: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>Last 100 events.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {events.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            No events yet.
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
      </CardContent>
    </Card>
  );
}
