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
import { SubmitButton } from "@/components/ui/submit-button";
import { revokeRosterMember, revokeCorporateCla } from "./actions";

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

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function CorporateClaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const corporates = await prisma.corporateCla.findMany({
    where: { projectId: id },
    include: {
      signature: {
        select: { ghLogin: true, ghId: true, legalName: true },
      },
      members: {
        orderBy: [{ status: "asc" }, { addedAt: "desc" }],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const disputedCount = corporates.reduce(
    (n, c) => n + c.members.filter((m) => m.status === "DISPUTED").length,
    0
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Corporate CLAs</CardTitle>
          <CardDescription>
            Companies that have signed a Corporate CLA, and their employee
            rosters. Rosters are self-service &mdash; the signatory adds and
            removes members. This is your maintainer view; you can revoke a
            roster entry or an entire corporate agreement here.
          </CardDescription>
        </CardHeader>
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
            No corporate CLAs have been signed yet. When a company signs a CCLA
            it will appear here with its self-service roster.
          </CardContent>
        </Card>
      ) : (
        corporates.map((c) => {
          const revoked = c.status === "REVOKED";
          return (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {c.companyName}
                      <Badge variant={revoked ? "destructive" : "success"}>
                        {c.status}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="mt-1 space-y-0.5">
                      <span className="block">
                        Contact:{" "}
                        <span className="text-foreground">
                          {c.contactEmail}
                        </span>
                      </span>
                      <span className="block">
                        Signatory:{" "}
                        <span className="text-foreground">
                          @{c.signature.ghLogin}
                        </span>{" "}
                        ({c.signature.legalName}
                        {c.signatoryTitle ? `, ${c.signatoryTitle}` : ""})
                      </span>
                      <span className="block text-xs">
                        Signed {fmt(c.createdAt)}
                        {revoked && c.revokedAt
                          ? ` · revoked ${fmt(c.revokedAt)}`
                          : ""}
                      </span>
                    </CardDescription>
                  </div>
                  {!revoked && (
                    <form action={revokeCorporateCla}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="corporateId" value={c.id} />
                      <SubmitButton variant="outline" size="sm">
                        Revoke corporate CLA
                      </SubmitButton>
                    </form>
                  )}
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
                              added {fmt(m.addedAt)}
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
    </div>
  );
}
