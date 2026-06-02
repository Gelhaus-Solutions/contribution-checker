import Link from "next/link";
import Image from "next/image";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireProjectPermission } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";

const STATUS_OPTIONS = [
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "DENIED", label: "Denied" },
] as const;

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
};

export default async function ProjectApplications({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireProjectPermission(id, "project_applications_review");

  const { page, perPage, skip, take, q } = parsePageParams(sp);

  const status = typeof sp.status === "string" ? sp.status : undefined;
  const filterStatus =
    status && STATUS_OPTIONS.some((s) => s.value === status)
      ? status
      : "SUBMITTED";

  const where: Prisma.ApplicationWhereInput = {
    projectId: id,
    status: filterStatus,
    ...(q
      ? {
          user: {
            OR: [
              { ghLogin: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };

  const [apps, total] = await prisma.$transaction([
    prisma.application.findMany({
      where,
      include: {
        user: { select: { ghLogin: true, image: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.application.count({ where }),
  ]);

  const basePath = `/dashboard/projects/${id}/applications`;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Applications</CardTitle>
        <nav className="flex gap-1">
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s.value}
              href={`${basePath}?status=${s.value}`}
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
        <div className="border-b border-border px-6 py-3">
          <SearchInput
            pathname={basePath}
            q={q}
            placeholder="Search login or name"
            hiddenParams={{ status: filterStatus }}
          />
        </div>
        {apps.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted-foreground">
            {q ? "No applications match your search." : "Nothing in this bucket."}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {apps.map((a) => (
              <li key={a.id}>
                <Link
                  href={`${basePath}/${a.id}`}
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
