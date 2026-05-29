import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { verifyChain } from "@/lib/cla/integrity";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { revokeSignature } from "../actions";

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function ClaSignatureLog({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const [signatures, events, chain] = await Promise.all([
    prisma.claSignature.findMany({
      where: { projectId: id },
      include: {
        corporateSignatory: { select: { id: true, companyName: true } },
      },
      orderBy: { signedAt: "desc" },
    }),
    prisma.claEventLog.findMany({
      where: { projectId: id },
      orderBy: { seq: "desc" },
      take: 200,
    }),
    verifyChain(id),
  ]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Signatures</CardTitle>
              <CardDescription>
                Immutable click-wrap records. Admin revoke is an append-only
                state change — the original record is retained.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {chain.ok ? (
                <Badge variant="success">chain verified</Badge>
              ) : (
                <Badge variant="destructive">
                  chain tampered at #{chain.brokenAtSeq}
                </Badge>
              )}
              <Button asChild variant="outline" size="sm">
                <a href="./export?format=csv">Export CSV</a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="./export?format=json">Export JSON</a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {signatures.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              No signatures yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {signatures.map((s) => (
                <li key={s.id} className="px-6 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={s.kind === "CCLA" ? "secondary" : "outline"}>
                        {s.kind}
                      </Badge>
                      <span className="font-mono">@{s.ghLogin}</span>
                      <span className="text-muted-foreground">{s.legalName}</span>
                      {s.corporateSignatory && (
                        <span className="text-muted-foreground">
                          · {s.corporateSignatory.companyName}
                        </span>
                      )}
                      {s.status === "ACTIVE" ? (
                        <Badge variant="success">ACTIVE</Badge>
                      ) : (
                        <Badge variant="destructive">REVOKED</Badge>
                      )}
                    </div>
                    <time className="text-xs text-muted-foreground">
                      {fmt(s.signedAt)}
                    </time>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      v{s.documentVersion}{" "}
                      <span className="font-mono">
                        {s.contentHash.slice(0, 8)}
                      </span>
                    </span>
                    <span className="font-mono">{s.ip}</span>
                    {s.signatureKind && (
                      <span>signature: {s.signatureKind}</span>
                    )}
                  </div>
                  {s.signatureKind === "typed" && s.signatureText && (
                    <div className="mt-2 font-[cursive] text-lg leading-none">
                      {s.signatureText}
                    </div>
                  )}
                  {s.signatureImage && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.signatureImage}
                      alt={`Signature of @${s.ghLogin}`}
                      className="mt-2 max-h-20 rounded-md border border-border bg-white p-1"
                    />
                  )}
                  {s.status === "ACTIVE" && (
                    <form
                      action={revokeSignature}
                      className="mt-2 flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="signatureId" value={s.id} />
                      <Input
                        name="reason"
                        placeholder="Revocation reason"
                        className="h-8 max-w-xs text-xs"
                        required
                      />
                      <SubmitButton variant="destructive" size="sm">
                        Revoke
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event ledger</CardTitle>
          <CardDescription>
            Last 200 entries of the hash-chained legal ledger, newest first.
          </CardDescription>
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        #{e.seq}
                      </span>
                      <Badge variant="outline">{e.kind}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {e.entryHash.slice(0, 8)}
                      </span>
                    </div>
                    <time className="text-xs text-muted-foreground">
                      {fmt(e.createdAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
