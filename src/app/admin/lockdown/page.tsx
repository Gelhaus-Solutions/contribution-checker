import Link from "next/link";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { SiteHeader } from "@/components/site-header";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { CopyButton } from "@/components/copy-button";
import { CodeBlock } from "@/components/code-block";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { SHELL_MEDIUM } from "@/lib/ui/layout";
import { formatDateTime, formatDateTimeSeconds } from "@/lib/ui/format";
import {
  GLOCKDOWN_APP,
  RUNGS,
  SOURCE_COPY,
  STAGES,
  STAGE_COPY,
  askEdgeNow,
  decoyFingerprints,
  inspectIdentity,
  lockdownStatus,
  stageStatus,
  type EdgeAnswer,
  type IdentityReport,
  type LockdownStatus,
  type Rung,
  type Stage,
} from "@/lib/lockdown";
import { RaiseForm, ReportDecoysForm } from "./forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "GLockdown" };

/**
 * The GLockdown console: everything this app knows about its kill switch, and
 * the two things it can do about it (src/lib/lockdown.ts). It shows the stage
 * in force and each source behind it, asks the edge live, shows this app's
 * TLS identity as the trust document must pin it, the honeytokens as hashes
 * only, and the lockdown audit trail. It can raise the app one rung and send
 * the decoy report now. Nothing here lowers anything: that is GLockdown's.
 *
 * Super-admins only, and at `full` nobody reaches it: the CLI
 * (`node dist/glockdown.mjs`) answers from a shell in the container then.
 */
export default async function LockdownConsole() {
  await requireSuperAdmin();
  const status = lockdownStatus();
  const identity = inspectIdentity();
  const fingerprints = decoyFingerprints();
  const [edgeAnswer, events] = await Promise.all([
    askEdgeNow(),
    prisma.auditEvent.findMany({
      where: { kind: { startsWith: "lockdown." } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        kind: true,
        payload: true,
        createdAt: true,
        actor: { select: { ghLogin: true, name: true } },
      },
    }),
  ]);
  const lastReport = events.find(
    (e) => e.kind === "lockdown.decoys_reported" || e.kind === "lockdown.decoys_report_failed",
  );

  return (
    <>
      <SiteHeader />
      <main className={`${SHELL_MEDIUM} space-y-6 py-10`}>
        <PageHeader
          back={{ href: "/admin", label: "Super-admin" }}
          title="GLockdown"
          description={`The kill switch for ${GLOCKDOWN_APP}: the stage in force, where it comes from, and what this app can do about it. Nothing here lowers a stage; lowering is GLockdown's.`}
          meta={<StatusBadge status={stageStatus(status.stage)} />}
          actions={
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/lockdown">Ask again</Link>
            </Button>
          }
        />

        <StageCard status={status} />
        <SourcesCard status={status} edgeAnswer={edgeAnswer} />
        <RaiseCard status={status} />
        <IdentityCard identity={identity} edgeUrl={status.edge.url} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Honeytokens</CardTitle>
            <CardDescription>
              A decoy admin and a decoy API key nobody uses (L97). Using either is refused exactly
              as an unknown account or key, and GLockdown is told, which raises AAL phase 1 for
              this app and whatever shares its host and database. Shown as hashes only, as
              GLockdown holds them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {status.decoys.logins + status.decoys.keys === 0 ? (
              <Alert variant="info" title="No decoys configured">
                GLockdown is still told that this app holds none, which is what flags a decoy in
                its inventory that this app no longer checks. Set{" "}
                <code>GLOCKDOWN_DECOY_LOGIN</code> and <code>GLOCKDOWN_DECOY_KEY_SHA256</code> to
                plant them.
              </Alert>
            ) : null}
            <Field label="Decoy sign-in names">{status.decoys.logins}</Field>
            <Field label="Decoy API keys">{status.decoys.keys}</Field>
            <Field label="Checked">
              Every session, before its identity is resolved; every API route, including
              unknown <code className="text-xs">/api</code> paths.
            </Field>
            {fingerprints.logins.length + fingerprints.keys.length > 0 ? (
              <Field label="Fingerprints">
                <ul className="space-y-0.5 font-mono text-xs">
                  {fingerprints.logins.map((h) => (
                    <li key={`l${h}`}>login {h.slice(0, 16)}</li>
                  ))}
                  {fingerprints.keys.map((h) => (
                    <li key={`k${h}`}>key {h.slice(0, 16)}</li>
                  ))}
                </ul>
              </Field>
            ) : null}
            <Field label="Last report">
              {lastReport ? (
                <ReportLine
                  ok={lastReport.kind === "lockdown.decoys_reported"}
                  at={lastReport.createdAt}
                  payload={parsePayload(lastReport.payload)}
                />
              ) : (
                <span className="text-muted-foreground">
                  None recorded. The worker reports at start and daily at 04:40 UTC.
                </span>
              )}
            </Field>
            <ReportDecoysForm disabled={!status.edge.asked} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity</CardTitle>
            <CardDescription>
              Raises, decoy trips and decoy reports, newest first. A trip never records the
              credential presented.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {events.map((e) => {
                  const kind = KIND[e.kind] ?? { label: e.kind, tone: "secondary" as const };
                  return (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                      <span className="w-32 shrink-0 font-mono text-xs text-muted-foreground">
                        {formatDateTime(e.createdAt)}
                      </span>
                      <Badge variant={kind.tone}>{kind.label}</Badge>
                      <span className="min-w-0 flex-1 break-words">
                        {summary(e.kind, parsePayload(e.payload))}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {e.actor ? (e.actor.ghLogin ?? e.actor.name ?? "a user") : "system"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>
              Read once at start. The identity and the edge are taken up on the next restart, so
              the stage source never forgets a stage it holds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CodeBlock language=".env" code={ENV_EXAMPLE} />
            <CodeBlock language="sh" code={CLI_EXAMPLE} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// The stage

/** A short note per rung for the ladder. Above AAL phase 2 GLockdown names the rung and this app has nothing to add. */
const RUNG_NOTE: Record<Rung, string> = {
  off: "Nothing refused",
  signups: "No new accounts",
  members: "Members only",
  admins: "Admins only",
  full: "Nobody signs in",
  aal: "AAL 1: every credential",
  aal2: "AAL 2: the bot stops",
  sil: "Above AAL 2",
  ail: "Above AAL 2",
};

const HELD_BY: Record<LockdownStatus["heldBy"], string> = {
  nothing: "Nothing: no source sets a stage.",
  floor: "The env floor CC_LOCKDOWN, which is stricter than GLockdown.",
  glockdown: "GLockdown, which is stricter than the env floor.",
  both: "The env floor and GLockdown alike.",
};

function StageCard({ status }: { status: LockdownStatus }) {
  const current = RUNGS.indexOf(status.rung);
  const ceiling = RUNGS.indexOf("aal");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stage in force</CardTitle>
        <CardDescription>{STAGE_COPY[status.stage].refuses}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-9" aria-label="GLockdown's ladder">
          {RUNGS.map((rung, i) => (
            <li
              key={rung}
              aria-current={i === current ? "step" : undefined}
              className={cn(
                "rounded-md border px-2 py-1.5",
                i === current
                  ? "border-primary bg-primary/10 text-primary-strong ring-1 ring-primary"
                  : i < current
                    ? "border-border bg-muted text-foreground"
                    : "border-dashed border-border text-muted-foreground",
              )}
            >
              <div className="font-mono text-xs font-medium">{rung}</div>
              <div className="text-[11px] leading-snug">{RUNG_NOTE[rung]}</div>
              {rung === status.floor && rung !== "off" ? (
                <div className="mt-1 text-[11px] font-medium">env floor</div>
              ) : null}
              {rung === status.next ? (
                <div className="mt-1 text-[11px] font-medium">next raise</div>
              ) : i > ceiling ? (
                <div className="mt-1 text-[11px]">GLockdown only</div>
              ) : null}
            </li>
          ))}
        </ol>
        <Field label="GLockdown's rung">
          <code className="text-xs">{status.rung}</code>
        </Field>
        <Field label="Held by">{HELD_BY[status.heldBy]}</Field>
        <Field label="Sessions">
          {status.stage === "full" ? (
            <Badge variant="destructive">All refused</Badge>
          ) : status.stage === "off" ? (
            <Badge variant="success">Everyone</Badge>
          ) : (
            <Badge variant="warning">Some refused</Badge>
          )}
          {status.refusesEveryCredential ? (
            <span className="ml-2 text-xs text-muted-foreground">
              AAL phase 1 or above: every credential is refused, sessions included.
            </span>
          ) : null}
        </Field>
        <Field label="Bot">
          {status.botStopped ? (
            <>
              <Badge variant="destructive">Stopped</Badge>
              <span className="ml-2 text-xs text-muted-foreground">
                AAL phase 2: the GitHub webhook and the CI routes answer 503, and no pull request
                is gated or touched.
              </span>
            </>
          ) : (
            <>
              <Badge variant="success">Running</Badge>
              <span className="ml-2 text-xs text-muted-foreground">
                Signed webhooks and the CI check work at every stage below AAL phase 2.
              </span>
            </>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

function SourcesCard({
  status,
  edgeAnswer,
}: {
  status: LockdownStatus;
  edgeAnswer: EdgeAnswer;
}) {
  const r = status.reading;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sources</CardTitle>
        <CardDescription>
          The stage in force is the strictest of these, and none can lower another. The agent&apos;s
          file and the edge each keep their last good answer while silent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Field label="Env floor">
          <StatusBadge status={stageStatus(status.floor)} />{" "}
          <code className="text-xs">CC_LOCKDOWN</code>
        </Field>
        <Field label="GLockdown">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={stageStatus(r.stage)} />
              {r.rung ? <code className="text-xs">rung {r.rung}</code> : null}
              {r.at ? (
                <span className="text-xs text-muted-foreground">
                  set {formatDateTimeSeconds(r.at * 1000)} UTC
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{SOURCE_COPY[r.source]}</p>
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {status.stageFile}
            </p>
          </div>
        </Field>
        <Field label="Edge, asked now">
          <EdgeLine answer={edgeAnswer} url={status.edge.url} />
        </Field>
      </CardContent>
    </Card>
  );
}

function EdgeLine({ answer, url }: { answer: EdgeAnswer; url: string | null }) {
  if (!answer.asked) {
    return (
      <div className="space-y-1">
        <Badge variant="secondary">Not asked</Badge>
        <p className="text-xs text-muted-foreground">{answer.problem}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {answer.ok ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={stageStatus(answer.stage)} />
          <code className="text-xs">rung {answer.rung}</code>
          <span className="text-xs text-muted-foreground">
            set {formatDateTimeSeconds(answer.at * 1000)} UTC
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">{answer.code}</Badge>
          {answer.status ? (
            <span className="text-xs text-muted-foreground">HTTP {answer.status}</span>
          ) : null}
          {answer.detail ? (
            <span className="text-xs text-muted-foreground">{answer.detail}</span>
          ) : null}
        </div>
      )}
      {url ? <p className="font-mono text-[11px] break-all text-muted-foreground">{url}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raising

const isStageRung = (r: Rung): r is Stage => (STAGES as readonly string[]).includes(r);

function RaiseCard({ status }: { status: LockdownStatus }) {
  const next = status.next;
  const signsOutAdmins = next === "full" || next === "aal";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Raise one rung</CardTitle>
        <CardDescription>
          Asks GLockdown to raise this app one rung, over its pinned TLS identity. An app raises
          only itself, one rung at a time, up to AAL; Identity and Control go further.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!status.edge.asked ? (
          <Alert variant="warning" title="GLockdown's edge is not configured">
            {status.edge.problem}. A raise goes to the edge, so there is nothing to ask until it
            is.
          </Alert>
        ) : next === null ? (
          <Alert variant="info" title={`GLockdown holds this app at ${status.rung}`}>
            That is as high as an app may raise itself.
          </Alert>
        ) : (
          <>
            <p>
              From <code className="text-xs">{status.rung}</code> to{" "}
              <code className="text-xs">{next}</code>:{" "}
              {isStageRung(next)
                ? STAGE_COPY[next].refuses
                : "AAL phase 1. Every credential is refused, existing sessions included; the bot keeps running."}
            </p>
            {isStageRung(next) && status.heldBy === "floor" ? (
              <p className="text-xs text-muted-foreground">
                The env floor holds {status.floor}, so the stage in force stays {status.stage}{" "}
                until GLockdown&apos;s rung passes it.
              </p>
            ) : null}
            {signsOutAdmins ? (
              <Alert variant="warning" title="This signs you out too">
                Super-admins are refused from {next === "full" ? "full" : "AAL phase 1"}, so this
                console is out of reach until GLockdown lowers the stage. The CLI still answers
                from a shell in the container.
              </Alert>
            ) : null}
          </>
        )}
        <RaiseForm
          from={status.rung}
          to={next ?? status.rung}
          disabled={!status.edge.asked || next === null}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Identity

const DAY_MS = 24 * 60 * 60 * 1000;

function IdentityCard({ identity, edgeUrl }: { identity: IdentityReport; edgeUrl: string | null }) {
  const cert = identity.certificate;
  const daysLeft = cert ? Math.floor((cert.validTo.getTime() - Date.now()) / DAY_MS) : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Identity</CardTitle>
        <CardDescription>
          This app&apos;s TLS identity, which the operator&apos;s trust document pins as{" "}
          {GLOCKDOWN_APP}, and the edge&apos;s pins it accepts. Every call to GLockdown is pinned
          both ways; the key is never shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Field label="Directory">
          <code className="text-xs break-all">{identity.dir}</code>
        </Field>
        {cert ? (
          <>
            <Field label="Subject">
              <code className="text-xs">{cert.subject}</code>
            </Field>
            <Field label="Issuer">
              <code className="text-xs">{cert.issuer}</code>
            </Field>
            <Field label="Valid">
              <span className="text-xs">
                {formatDateTime(cert.validFrom)} to {formatDateTime(cert.validTo)} UTC
              </span>{" "}
              {daysLeft < 0 ? (
                <Badge variant="destructive">Expired</Badge>
              ) : daysLeft < 30 ? (
                <Badge variant="warning">{daysLeft} days left</Badge>
              ) : (
                <Badge variant="success">Valid</Badge>
              )}
            </Field>
            <Field label="Key">
              {cert.key === "matches" ? (
                <Badge variant="success">Pairs with the certificate</Badge>
              ) : cert.key === "mismatch" ? (
                <Badge variant="destructive">Does not pair with the certificate</Badge>
              ) : (
                <Badge variant="destructive">tls.key missing or unreadable</Badge>
              )}
            </Field>
            <Field label="Pin">
              <div className="flex flex-wrap items-center gap-1">
                <code className="break-all text-xs">{cert.pin}</code>
                <CopyButton value={cert.pin} iconOnly label="Copy pin" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                The trust document must list this pin for {GLOCKDOWN_APP}.
              </p>
            </Field>
          </>
        ) : (
          <Alert variant="warning" title="No identity">
            {identity.problem}. The agent&apos;s file still counts; the edge cannot be asked, and
            nothing can be raised or reported.
          </Alert>
        )}
        <Field label="Edge">
          <code className="text-xs">{edgeUrl ?? "(GLOCKDOWN_EDGE_URL unset)"}</code>
        </Field>
        <Field label="Edge pins">
          {identity.edgePins.length === 0 ? (
            <span className="text-muted-foreground">(GLOCKDOWN_EDGE_PINS unset)</span>
          ) : (
            <ul className="space-y-1">
              {identity.edgePins.map(({ pin, wellFormed }) => (
                <li key={pin} className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-xs">{pin}</code>
                  {wellFormed ? null : <Badge variant="destructive">Not a SHA-256 pin</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit rows

const KIND: Record<string, { label: string; tone: NonNullable<BadgeProps["variant"]> }> = {
  "lockdown.escalated": { label: "Raised", tone: "warning" },
  "lockdown.escalate_failed": { label: "Raise refused", tone: "destructive" },
  "lockdown.decoy_tripped": { label: "Decoy used", tone: "destructive" },
  "lockdown.decoys_reported": { label: "Decoys reported", tone: "secondary" },
  "lockdown.decoys_report_failed": { label: "Report failed", tone: "warning" },
};

const payloadSchema = z.record(z.unknown());

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : "?";
}

function summary(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case "lockdown.escalated":
      return `From ${str(p.from)}, expected ${p.expected ? str(p.expected) : "no higher rung"} (${str(p.via)}): ${str(p.reason)}`;
    case "lockdown.escalate_failed":
      return `From ${str(p.from)}, ${str(p.code)}${p.detail ? ` (${str(p.detail)})` : ""} (${str(p.via)}): ${str(p.reason)}`;
    case "lockdown.decoy_tripped":
      return `${str(p.signal)}: ${str(p.detail)}. ${p.told === true ? "GLockdown was told." : `GLockdown was not told (${str(p.code)}).`}`;
    case "lockdown.decoys_reported":
      return `${str(p.trigger)}: ${str(p.logins)} sign-in names, ${str(p.keys)} keys.`;
    case "lockdown.decoys_report_failed":
      return `${str(p.trigger)}: ${str(p.code)}${p.detail ? ` (${str(p.detail)})` : ""}.`;
    default:
      return "";
  }
}

/** GLockdown's answer to a report, as the flat pairs it gives (how many it judged, how many it does not list). */
function answerPairs(answer: unknown): [string, string][] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
  return Object.entries(answer as Record<string, unknown>)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => [k, String(v)]);
}

function ReportLine({
  ok,
  at,
  payload,
}: {
  ok: boolean;
  at: Date;
  payload: Record<string, unknown>;
}) {
  const pairs = ok ? answerPairs(payload.answer) : [];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={ok ? "success" : "warning"}>{ok ? "Accepted" : "Failed"}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(at)} UTC, {str(payload.trigger)}
        </span>
      </div>
      {ok ? (
        pairs.length > 0 ? (
          <p className="font-mono text-xs">{pairs.map(([k, v]) => `${k}: ${v}`).join(", ")}</p>
        ) : null
      ) : (
        <p className="text-xs text-muted-foreground">
          {str(payload.code)}
          {payload.detail ? ` (${str(payload.detail)})` : ""}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[160px_1fr] sm:items-baseline sm:gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const ENV_EXAMPLE = `# GLockdown (src/lib/lockdown.ts)
# A floor nothing in the app can lower: off, signups, members, admins or full
CC_LOCKDOWN="off"
# Where the GLockdown agent writes this app's stage (mounted read-only)
GLOCKDOWN_STAGE_DIR="/run/glockdown/apps"
# The edge's apps listener and the SHA-256 SPKI pins of its key
GLOCKDOWN_EDGE_URL="https://glockdown.example:8444"
GLOCKDOWN_EDGE_PINS="<pin>,<pin>"
# This app's identity: tls.crt and tls.key, pinned in the trust document
GLOCKDOWN_IDENTITY_DIR="/etc/glockdown-app"
# Honeytokens (L97): the decoy admin's sign-in names (email or GitHub login),
# and the SHA-256 of each decoy API key. The key itself is planted where an
# intruder would look, never here.
GLOCKDOWN_DECOY_LOGIN="ops-admin@example.com,cc-ops"
GLOCKDOWN_DECOY_KEY_SHA256="<64 hex digits>"`;

const CLI_EXAMPLE = `# From a shell in the container, also when the console is out of reach
node dist/glockdown.mjs status          # the stage, its sources, the identity
node dist/glockdown.mjs ask             # the edge's answer, now
node dist/glockdown.mjs escalate --reason "suspicious sign-ins"
node dist/glockdown.mjs report-decoys   # the decoy inventory, now
node dist/glockdown.mjs pin             # this app's pin for the trust document
node dist/glockdown.mjs hash-key < key  # the SHA-256 to configure for a decoy key`;
