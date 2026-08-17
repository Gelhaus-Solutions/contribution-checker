import type { Prisma } from "@prisma/client";
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
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";
import { formatDateTimeSeconds } from "@/lib/ui/format";
import {
  revokeRosterMember,
  revokeCorporateCla,
  approveCorporateCla,
  rejectCorporateCla,
} from "./actions";

function rosterBadgeVariant(
  status: string
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DISPUTED":
      return "warning";
    case "REVOKED":
      return "destructive";
    default:
      return "secondary";
  }
}

function corporateBadgeVariant(
  status: string
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PENDING":
      return "warning";
    case "REJECTED":
      return "destructive";
    default:
      // REVOKED and any future states.
      return "secondary";
  }
}

export default async function CorporateClaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireProjectRole(id, "ADMIN");

  const { page, perPage, skip, take, q } = parsePageParams(sp);

  const where: Prisma.CorporateClaWhereInput = {
    projectId: id,
    ...(q
      ? {
          OR: [
            { companyName: { contains: q, mode: "insensitive" } },
            { contactEmail: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // disputedCount and pendingCount are project-wide (not just the current page),
  // so compute them with dedicated aggregates rather than reducing over the page
  // slice.
  const [corporates, total, disputedCount, pendingCount] =
    await prisma.$transaction([
      prisma.corporateCla.findMany({
        where,
        include: {
          signature: {
            select: { ghLogin: true, ghId: true, legalName: true },
          },
          members: {
            orderBy: [{ status: "asc" }, { addedAt: "desc" }],
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.corporateCla.count({ where }),
      prisma.cclaRosterMember.count({
        where: { projectId: id, status: "DISPUTED" },
      }),
      prisma.corporateCla.count({
        where: { projectId: id, status: "PENDING" },
      }),
    ]);

  const basePath = `/dashboard/projects/${id}/cla/corporate`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Corporate CLAs</CardTitle>
          <CardDescription>
            Companies that have signed a Corporate CLA, and their employee
            rosters. Rosters are self-service: the signatory adds and
            removes members. This is your maintainer view; you can revoke a
            roster entry or an entire corporate agreement here.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <SearchInput
            pathname={basePath}
            q={q}
            placeholder="Search company or contact email"
          />
        </CardContent>
        {pendingCount > 0 && (
          <CardContent className="pt-0">
            <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <span className="font-medium">
                {pendingCount} corporate CLA
                {pendingCount === 1 ? "" : "s"} awaiting approval
              </span>
              <span className="block text-xs text-muted-foreground">
                A signed corporate CLA does not cover its roster until you
                approve it. Review the pending entries below and approve or
                reject each one.
              </span>
            </div>
          </CardContent>
        )}
        {disputedCount > 0 && (
          <CardContent className="pt-0">
            <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <span className="font-medium">
                {disputedCount} disputed roster{" "}
                {disputedCount === 1 ? "membership" : "memberships"}
              </span>
              <span className="block text-xs text-muted-foreground">
                A contributor has asserted they are not affiliated. Their
                coverage is suspended and they cannot be re-added until they
                consent. Review the highlighted entries below.
              </span>
            </div>
          </CardContent>
        )}
      </Card>

      {corporates.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
            {q
              ? "No corporate CLAs match your search."
              : "No corporate CLAs have been signed yet. When a company signs a CCLA it will appear here with its self-service roster."}
          </CardContent>
        </Card>
      ) : (
        corporates.map((c) => {
          const revoked = c.status === "REVOKED";
          const pending = c.status === "PENDING";
          const rejected = c.status === "REJECTED";
          return (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {c.companyName}
                      <Badge variant={corporateBadgeVariant(c.status)}>
                        {c.status}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="mt-1 space-y-0.5">
                      {(c.registeredAddress || c.country) && (
                        <span className="block">
                          Registered address:{" "}
                          <span className="text-foreground">
                            {[c.registeredAddress, c.country]
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                        </span>
                      )}
                      <span className="block">
                        Point of contact:{" "}
                        <span className="text-foreground">
                          {c.contactName ? `${c.contactName} · ` : ""}
                          {c.contactEmail}
                        </span>
                      </span>
                      <span className="block">
                        Authorized representative:{" "}
                        <span className="text-foreground">
                          @{c.signature.ghLogin}
                        </span>{" "}
                        ({c.signature.legalName}
                        {c.signatoryTitle ? `, ${c.signatoryTitle}` : ""})
                      </span>
                      <span className="block text-xs">
                        Signed
                        {c.signatureText ? ` “${c.signatureText}”` : ""} on{" "}
                        {formatDateTimeSeconds(c.createdAt)}
                        {revoked && c.revokedAt
                          ? ` · revoked ${formatDateTimeSeconds(c.revokedAt)}`
                          : ""}
                        {rejected && c.rejectedAt
                          ? ` · rejected ${formatDateTimeSeconds(c.rejectedAt)}`
                          : ""}
                      </span>
                      {rejected && c.rejectReason && (
                        <span className="block text-xs">
                          Rejection reason:{" "}
                          <span className="text-foreground">
                            {c.rejectReason}
                          </span>
                        </span>
                      )}
                    </CardDescription>
                  </div>
                  {pending ? (
                    <div className="flex flex-col items-end gap-2">
                      <form action={approveCorporateCla}>
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="corporateId" value={c.id} />
                        <SubmitButton size="sm">Approve</SubmitButton>
                      </form>
                      <form
                        action={rejectCorporateCla}
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="corporateId" value={c.id} />
                        <Input
                          type="text"
                          name="reason"
                          placeholder="Reason (optional)"
                          className="h-8 w-44 text-xs"
                        />
                        <SubmitButton variant="outline" size="sm">
                          Reject
                        </SubmitButton>
                      </form>
                    </div>
                  ) : c.status === "ACTIVE" ? (
                    <form action={revokeCorporateCla}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="corporateId" value={c.id} />
                      <SubmitButton variant="outline" size="sm">
                        Revoke corporate CLA
                      </SubmitButton>
                    </form>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {c.members.length === 0 ? (
                  <div className="px-6 pb-6 text-sm text-muted-foreground">
                    No roster members.
                  </div>
                ) : (
                  <ul className="divide-y divide-border border-t border-border">
                    {c.members.map((m) => {
                      const disputed = m.status === "DISPUTED";
                      return (
                        <li
                          key={m.id}
                          className={
                            "flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm" +
                            (disputed ? " bg-warning/5" : "")
                          }
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant={rosterBadgeVariant(m.status)}>
                              {m.status}
                            </Badge>
                            <span className="font-mono">@{m.ghLogin}</span>
                            {m.ghId != null && (
                              <span className="text-xs text-muted-foreground">
                                #{m.ghId}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <time className="text-xs text-muted-foreground">
                              added {formatDateTimeSeconds(m.addedAt)}
                            </time>
                            {m.status === "ACTIVE" && (
                              <form action={revokeRosterMember}>
                                <input
                                  type="hidden"
                                  name="projectId"
                                  value={id}
                                />
                                <input
                                  type="hidden"
                                  name="memberId"
                                  value={m.id}
                                />
                                <SubmitButton variant="outline" size="sm">
                                  Revoke
                                </SubmitButton>
                              </form>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {c.members.some(
                  (m) => m.status === "DISPUTED" && m.disputeNote
                ) && (
                  <div className="space-y-1 border-t border-border px-6 py-3">
                    {c.members
                      .filter((m) => m.status === "DISPUTED" && m.disputeNote)
                      .map((m) => (
                        <p
                          key={m.id}
                          className="text-xs text-muted-foreground"
                        >
                          <span className="font-mono">@{m.ghLogin}</span>{" "}
                          dispute note: {m.disputeNote}
                        </p>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      <Pagination
        pathname={basePath}
        searchParams={sp}
        page={page}
        perPage={perPage}
        total={total}
        className="px-0"
      />
    </div>
  );
}
