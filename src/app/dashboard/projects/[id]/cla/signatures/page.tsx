import type { Prisma } from "@prisma/client";
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
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import {
  parsePageParams,
  siblingParams,
  type SearchParamRecord,
} from "@/lib/pagination";
import { parseFormSchema } from "@/lib/applications/schema";
import { revokeSignature, grantWaiver, revokeWaiver } from "../actions";

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Safely parse the customFields JSON column into [id, value] entries. */
function parseCustomAnswers(json: string | null): [string, unknown][] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : [];
  } catch {
    return [];
  }
}

function renderAnswer(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null || v === undefined || v === "") return "n/a";
  return String(v);
}

export default async function ClaSignatureLog({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireProjectRole(id, "ADMIN");

  // Three independent paginators share this route, so each uses its own param
  // namespace and carries the others' state across navigation.
  const sig = parsePageParams(sp, { keys: { page: "spage", q: "sq" } });
  const wai = parsePageParams(sp, { keys: { page: "wpage", q: "wq" } });
  const evt = parsePageParams(sp, { keys: { page: "epage", q: "eq" } });

  const sigWhere: Prisma.ClaSignatureWhereInput = {
    projectId: id,
    ...(sig.q
      ? {
          OR: [
            { ghLogin: { contains: sig.q, mode: "insensitive" } },
            { legalName: { contains: sig.q, mode: "insensitive" } },
            { emailSnapshot: { contains: sig.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const waiWhere: Prisma.ClaWaiverWhereInput = {
    projectId: id,
    ...(wai.q
      ? {
          OR: [
            { ghLogin: { contains: wai.q, mode: "insensitive" } },
            { reason: { contains: wai.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const evtWhere: Prisma.ClaEventLogWhereInput = { projectId: id };

  const [
    [signatures, sigTotal, waivers, waiTotal, events, evtTotal],
    chain,
    project,
  ] = await Promise.all([
    prisma.$transaction([
      prisma.claSignature.findMany({
        where: sigWhere,
        include: {
          corporateSignatory: {
            select: {
              id: true,
              companyName: true,
              registeredAddress: true,
              country: true,
              contactName: true,
              contactEmail: true,
              signatoryTitle: true,
            },
          },
        },
        orderBy: { signedAt: "desc" },
        skip: sig.skip,
        take: sig.take,
      }),
      prisma.claSignature.count({ where: sigWhere }),
      prisma.claWaiver.findMany({
        where: waiWhere,
        orderBy: { grantedAt: "desc" },
        skip: wai.skip,
        take: wai.take,
      }),
      prisma.claWaiver.count({ where: waiWhere }),
      prisma.claEventLog.findMany({
        where: evtWhere,
        orderBy: { seq: "desc" },
        skip: evt.skip,
        take: evt.take,
      }),
      prisma.claEventLog.count({ where: evtWhere }),
    ]),
    verifyChain(id),
    prisma.project.findUnique({
      where: { id },
      select: { claIclaCustomFields: true, claCclaCustomFields: true },
    }),
  ]);

  const basePath = `/dashboard/projects/${id}/cla/signatures`;

  // Map custom-field ids → current labels for display (best-effort; the answer
  // values are the verbatim snapshot, labels reflect the current schema).
  const iclaFields = parseFormSchema(project?.claIclaCustomFields ?? "[]");
  const cclaFields = parseFormSchema(project?.claCclaCustomFields ?? "[]");
  const fieldLabel = (kind: string, fieldId: string): string => {
    const fields = kind === "CCLA" ? cclaFields : iclaFields;
    return fields.find((f) => f.id === fieldId)?.label ?? fieldId;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Signatures</CardTitle>
              <CardDescription>
                Immutable click-wrap records. Admin revoke is an append-only
                state change: the original record is retained.
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
          <div className="border-b border-border px-6 py-3">
            <SearchInput
              pathname={basePath}
              q={sig.q}
              keys={{ q: "sq" }}
              hiddenParams={siblingParams(sp, ["sq", "spage"])}
              placeholder="Search login, name, or email"
            />
          </div>
          {signatures.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
              {sig.q ? "No signatures match your search." : "No signatures yet."}
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
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      View entered details
                    </summary>
                    <dl className="mt-2 space-y-1.5 rounded-md border border-border bg-muted/20 p-3">
                      {s.corporateSignatory ? (
                        <>
                          <Detail
                            label="Legal entity"
                            value={s.corporateSignatory.companyName}
                          />
                          <Detail
                            label="Registered address"
                            value={s.corporateSignatory.registeredAddress}
                          />
                          <Detail
                            label="Country"
                            value={s.corporateSignatory.country}
                          />
                          <Detail
                            label="Point of contact"
                            value={[
                              s.corporateSignatory.contactName,
                              s.corporateSignatory.contactEmail,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          />
                          <Detail
                            label="Authorized representative"
                            value={s.legalName}
                          />
                          <Detail
                            label="Title"
                            value={s.corporateSignatory.signatoryTitle}
                          />
                        </>
                      ) : (
                        <Detail label="Full legal name" value={s.legalName} />
                      )}
                      {parseCustomAnswers(s.customFields).map(([fid, val]) => (
                        <Detail
                          key={fid}
                          label={fieldLabel(s.kind, fid)}
                          value={renderAnswer(val)}
                        />
                      ))}
                      <Detail label="Signed version" value={`v${s.documentVersion}`} />
                      <Detail label="Email (snapshot)" value={s.emailSnapshot} />
                      <Detail
                        label="Signature method"
                        value={s.signatureKind ?? "checkbox only"}
                      />
                      <Detail label="Content hash" value={s.contentHash} mono />
                      <Detail label="IP address" value={s.ip} mono />
                      <Detail label="User agent" value={s.userAgent} />
                      <Detail label="Affirmation" value={s.affirmation} />
                    </dl>
                  </details>
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
          <Pagination
            pathname={basePath}
            searchParams={sp}
            page={sig.page}
            perPage={sig.perPage}
            total={sigTotal}
            keys={{ page: "spage" }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLA waivers</CardTitle>
          <CardDescription>
            Exempt a specific GitHub account from signing the CLA. They are
            treated as covered and won&apos;t be blocked. Revoking re-blocks them.
            Every grant and revoke is recorded in the ledger above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            action={grantWaiver}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="projectId" value={id} />
            <div className="space-y-1">
              <label
                htmlFor="waiver-login"
                className="text-xs text-muted-foreground"
              >
                GitHub username
              </label>
              <Input
                id="waiver-login"
                name="ghLogin"
                required
                maxLength={39}
                placeholder="octocat"
                className="h-8 w-48 text-sm"
              />
            </div>
            <div className="min-w-[14rem] flex-1 space-y-1">
              <label
                htmlFor="waiver-reason"
                className="text-xs text-muted-foreground"
              >
                Reason
              </label>
              <Input
                id="waiver-reason"
                name="reason"
                required
                maxLength={500}
                placeholder="e.g. covered by a separate signed agreement"
                className="h-8 text-sm"
              />
            </div>
            <SubmitButton size="sm">Grant waiver</SubmitButton>
          </form>

          <SearchInput
            pathname={basePath}
            q={wai.q}
            keys={{ q: "wq" }}
            hiddenParams={siblingParams(sp, ["wq", "wpage"])}
            placeholder="Search login or reason"
          />

          {waivers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {wai.q ? "No waivers match your search." : "No waivers yet."}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {waivers.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">@{w.ghLogin}</span>
                    {w.status === "ACTIVE" ? (
                      <Badge variant="success">ACTIVE</Badge>
                    ) : (
                      <Badge variant="destructive">REVOKED</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {w.reason}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      · {fmt(w.grantedAt)}
                    </span>
                  </div>
                  {w.status === "ACTIVE" && (
                    <form action={revokeWaiver}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="waiverId" value={w.id} />
                      <SubmitButton variant="outline" size="sm">
                        Revoke
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Pagination
            pathname={basePath}
            searchParams={sp}
            page={wai.page}
            perPage={wai.perPage}
            total={waiTotal}
            keys={{ page: "wpage" }}
            className="px-0"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event ledger</CardTitle>
          <CardDescription>
            The hash-chained legal ledger, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
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
          <Pagination
            pathname={basePath}
            searchParams={sp}
            page={evt.page}
            perPage={evt.perPage}
            total={evtTotal}
            keys={{ page: "epage" }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 font-medium text-muted-foreground sm:w-44">
        {label}
      </dt>
      <dd className={mono ? "break-all font-mono" : "break-words"}>{value}</dd>
    </div>
  );
}
