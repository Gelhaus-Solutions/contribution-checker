import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { parseFormSchema } from "@/lib/applications/schema";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { approveAction, denyAction, revokeAction, addNoteAction } from "./actions";
import { computeScore } from "@/lib/quality/score";
import { ALL_HEURISTICS, parseQualityConfig } from "@/lib/quality/registry";
import type { SignalsRaw } from "@/lib/quality/types";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
};

export default async function ApplicationDetail({
  params,
}: {
  params: Promise<{ id: string; appId: string }>;
}) {
  const { id, appId } = await params;
  const { session } = await requireProjectRole(id, "REVIEWER");

  const app = await prisma.application.findFirst({
    where: { id: appId, projectId: id },
    include: {
      user: { select: { id: true, ghLogin: true, name: true, image: true, email: true } },
      decidedBy: { select: { ghLogin: true } },
      project: {
        select: {
          id: true,
          formSchema: true,
          cooldownDays: true,
          qualityEnabled: true,
          qualityConfig: true,
        },
      },
      notes: {
        include: { author: { select: { ghLogin: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!app) notFound();

  // Aggregate this user's PR Quality across all PRs in the project (any
  // status). The averages help reviewers judge a SUBMITTED application by
  // looking at the user's historical PR quality.
  const userPrChecks =
    app.user.ghLogin && app.project.qualityEnabled
      ? await prisma.prCheck.findMany({
          where: {
            authorGhLogin: app.user.ghLogin,
            repo: { projectId: id },
          },
          include: {
            repo: { select: { fullName: true } },
            quality: { select: { signalsRaw: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 50,
        })
      : [];
  const qualityConfig = parseQualityConfig(app.project.qualityConfig);
  const userPrSummaries = userPrChecks.map((c) => {
    if (!c.quality) return { repoFullName: c.repo.fullName, prNumber: c.prNumber, score: null as number | null };
    const signals = JSON.parse(c.quality.signalsRaw) as SignalsRaw;
    const summary = computeScore(signals, qualityConfig);
    return {
      repoFullName: c.repo.fullName,
      prNumber: c.prNumber,
      status: c.status,
      score: summary.score,
      failed: summary.failedIds.map((fid) => {
        const h = ALL_HEURISTICS.find((x) => x.id === fid);
        return h?.label ?? fid;
      }),
    };
  });
  const scored = userPrSummaries.filter((s) => s.score !== null) as Array<
    typeof userPrSummaries[number] & { score: number }
  >;
  const avgQuality =
    scored.length > 0
      ? Math.round(scored.reduce((a, b) => a + b.score, 0) / scored.length)
      : null;

  const fields = parseFormSchema(app.project.formSchema);
  const answers = (() => {
    try {
      return JSON.parse(app.answers) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const isPending = app.status === "SUBMITTED";
  const isApproved = app.status === "APPROVED";
  const isDenied = app.status === "DENIED";
  const cooldownDays = app.project.cooldownDays;
  const cooldownHelp =
    cooldownDays != null
      ? `Cooldown set to ${cooldownDays} day${cooldownDays === 1 ? "" : "s"}.`
      : `No cooldown configured — applicant can resubmit immediately.`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href={`/dashboard/projects/${id}/applications`}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to queue
        </Link>
        <Badge variant={STATUS_VARIANT[app.status] ?? "secondary"}>
          {app.status}
        </Badge>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            {app.user.image && (
              <Image
                src={app.user.image}
                alt={app.user.ghLogin ?? ""}
                width={40}
                height={40}
                className="rounded-full"
              />
            )}
            <div>
              <CardTitle className="text-base">
                {app.user.ghLogin ?? "(no login)"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{app.user.name}</p>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Submitted {app.createdAt.toISOString().slice(0, 10)}</div>
            {app.decidedAt && (
              <div>
                {app.status === "APPROVED" ? "Approved" : "Denied"} by{" "}
                {app.decidedBy?.ghLogin ?? "system"} on{" "}
                {app.decidedAt.toISOString().slice(0, 10)}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The form had no fields when this application was submitted.
            </p>
          ) : (
            fields.map((f) => (
              <div key={f.id}>
                <Label className="text-xs">{f.label}</Label>
                <div className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  {f.type === "checkbox"
                    ? answers[f.id]
                      ? "✓ Yes"
                      : "✗ No"
                    : (() => {
                        const v = answers[f.id];
                        return typeof v === "string" && v.length > 0 ? v : "—";
                      })()}
                </div>
              </div>
            ))
          )}
          {app.reason && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <span className="font-medium">Decision note: </span>
              {app.reason}
            </div>
          )}
        </CardContent>
      </Card>

      {(isPending || isApproved || isDenied) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isPending
                ? "Decide"
                : isApproved
                  ? "Revoke approval"
                  : "Reinstate approval"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPending ? (
              <>
                <form action={approveAction} className="space-y-2">
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="appId" value={app.id} />
                  <Label htmlFor="reason-approve" className="text-xs">
                    Optional note
                  </Label>
                  <Textarea
                    id="reason-approve"
                    name="reason"
                    rows={2}
                    placeholder="Welcome aboard…"
                  />
                  <Button type="submit" variant="success">
                    Approve
                  </Button>
                </form>
                <form action={denyAction} className="space-y-2">
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="appId" value={app.id} />
                  <Label htmlFor="reason-deny" className="text-xs">
                    Reason (shown to applicant)
                  </Label>
                  <Textarea
                    id="reason-deny"
                    name="reason"
                    rows={2}
                    placeholder="Optional"
                  />
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      name="allowResubmit"
                      defaultChecked
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">Allow resubmitting</span>
                      <span className="ml-1 text-muted-foreground">
                        — {cooldownHelp}
                      </span>
                    </span>
                  </label>
                  <Button type="submit" variant="destructive">
                    Deny
                  </Button>
                </form>
              </>
            ) : isApproved ? (
              <form action={revokeAction} className="space-y-2">
                <input type="hidden" name="projectId" value={id} />
                <input type="hidden" name="appId" value={app.id} />
                <Label htmlFor="reason-revoke" className="text-xs">
                  Reason (shown to applicant)
                </Label>
                <Textarea
                  id="reason-revoke"
                  name="reason"
                  rows={2}
                  placeholder="Why revoke?"
                />
                <fieldset className="space-y-1 text-xs">
                  <legend className="font-medium">After revoking, set status to:</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="target" value="DENIED" defaultChecked />
                    <span>Denied (default cooldown applies)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="target" value="SUBMITTED" />
                    <span>Submitted (back to review queue)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="target" value="PENDING" />
                    <span>Pending (applicant may resubmit immediately)</span>
                  </label>
                </fieldset>
                <p className="text-xs text-muted-foreground">
                  Revoking will close any of their currently open PRs across
                  this project&apos;s repos.
                </p>
                <Button type="submit" variant="destructive">
                  Revoke approval
                </Button>
              </form>
            ) : (
              <form action={approveAction} className="space-y-2">
                <input type="hidden" name="projectId" value={id} />
                <input type="hidden" name="appId" value={app.id} />
                <Label htmlFor="reason-reapprove" className="text-xs">
                  Optional note
                </Label>
                <Textarea
                  id="reason-reapprove"
                  name="reason"
                  rows={2}
                  placeholder="Welcome back…"
                />
                <p className="text-xs text-muted-foreground">
                  Re-approving will reopen any PRs that were closed when this
                  application was denied.
                </p>
                <Button type="submit" variant="success">
                  Re-approve
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {app.project.qualityEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">PR Quality</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {avgQuality === null ? (
              <p className="text-sm text-muted-foreground">
                {userPrChecks.length === 0
                  ? "This applicant has no tracked PRs in the project."
                  : "No quality scores recorded yet for this user. Run a backfill from the Quality tab."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="text-3xl font-semibold">{avgQuality}%</div>
                  <div className="text-xs text-muted-foreground">
                    average across {scored.length} scored PR(s) (of{" "}
                    {userPrChecks.length} tracked)
                  </div>
                </div>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {userPrSummaries.slice(0, 12).map((p) => (
                    <li
                      key={`${p.repoFullName}#${p.prNumber}`}
                      className="px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          className="font-mono text-xs underline"
                          href={`https://github.com/${p.repoFullName}/pull/${p.prNumber}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {p.repoFullName}#{p.prNumber}
                        </a>
                        <Badge
                          variant={
                            p.score === null
                              ? "outline"
                              : p.score < 50
                                ? "destructive"
                                : p.score < 75
                                  ? "warning"
                                  : "success"
                          }
                          className="text-[10px]"
                        >
                          {p.score === null ? "not scored" : `${p.score}%`}
                        </Badge>
                      </div>
                      {p.score !== null && p.failed && p.failed.length > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          flagged: {p.failed.slice(0, 5).join(" • ")}
                          {p.failed.length > 5 ? ` +${p.failed.length - 5} more` : ""}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internal notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {app.notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notes yet. Notes are visible only to project members.
            </p>
          ) : (
            <ul className="space-y-3">
              {app.notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                >
                  <div className="mb-1 text-xs text-muted-foreground">
                    {n.author.ghLogin} ·{" "}
                    {n.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                  </div>
                  <div className="whitespace-pre-wrap">{n.body}</div>
                </li>
              ))}
            </ul>
          )}
          <form action={addNoteAction} className="space-y-2">
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="appId" value={app.id} />
            <input type="hidden" name="actorId" value={session.user.id} />
            <Textarea
              name="body"
              rows={2}
              required
              placeholder="Add a note for the team…"
            />
            <Button type="submit" size="sm" variant="outline">
              Post note
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
