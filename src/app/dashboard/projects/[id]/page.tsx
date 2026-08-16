import Link from "next/link";
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
import { StatusBadge } from "@/components/status-badge";


export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectPermission(id, "project_overview_view");

  const [counts, recent] = await Promise.all([
    prisma.application.groupBy({
      by: ["status"],
      where: { projectId: id },
      _count: true,
    }),
    prisma.application.findMany({
      where: { projectId: id },
      include: { user: { select: { ghLogin: true, image: true } } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Submitted" value={byStatus.SUBMITTED ?? 0} variant="warning" />
        <StatCard label="Approved" value={byStatus.APPROVED ?? 0} variant="success" />
        <StatCard label="Denied" value={byStatus.DENIED ?? 0} variant="destructive" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent applications</CardTitle>
          <CardDescription>Latest 8 submissions across all statuses.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              Nothing yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/dashboard/projects/${id}/applications/${a.id}`}
                    className="flex items-center justify-between gap-3 px-6 py-3 text-sm transition-colors hover:bg-muted/60"
                  >
                    <span className="font-medium">{a.user.ghLogin ?? "(unknown)"}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {a.createdAt.toISOString().slice(0, 10)}
                      </span>
                      <StatusBadge status={a.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "default" | "secondary" | "success" | "warning" | "destructive";
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold">{value}</span>
          <Badge variant={variant} className="text-[10px]">
            {label}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
