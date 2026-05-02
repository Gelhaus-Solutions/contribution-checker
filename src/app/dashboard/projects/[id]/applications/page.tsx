import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STATUS_OPTIONS = [
  { value: "SUBMITTED", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "DENIED", label: "Denied" },
  { value: "REVOKED", label: "Revoked" },
] as const;

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
  REVOKED: "secondary",
};

export default async function ProjectApplications({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id } = await params;
  const { status } = await searchParams;
  await requireProjectRole(id, "REVIEWER");

  const filterStatus =
    status && STATUS_OPTIONS.some((s) => s.value === status) ? status : "SUBMITTED";

  const apps = await prisma.application.findMany({
    where: { projectId: id, status: filterStatus },
    include: {
      user: { select: { ghLogin: true, image: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Applications</CardTitle>
        <nav className="flex gap-1">
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s.value}
              href={`/dashboard/projects/${id}/applications?status=${s.value}`}
              className={
                filterStatus === s.value
                  ? "rounded-md bg-muted px-2.5 py-1 text-xs font-medium"
                  : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
              }
            >
              {s.label}
            </Link>
          ))}
        </nav>
      </CardHeader>
      <CardContent className="p-0">
        {apps.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            Nothing in this bucket.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {apps.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/dashboard/projects/${id}/applications/${a.id}`}
                  className="flex items-center justify-between gap-3 px-6 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    {a.user.image && (
                      <Image
                        src={a.user.image}
                        alt={a.user.ghLogin ?? ""}
                        width={28}
                        height={28}
                        className="rounded-full"
                      />
                    )}
                    <div>
                      <div className="text-sm font-medium">
                        {a.user.ghLogin ?? "(no login)"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.user.name}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {a.createdAt.toISOString().slice(0, 10)}
                    </span>
                    <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>
                      {a.status}
                    </Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
