import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireProjectPermission, getProjectMembership, roleAtLeast, type Role } from "@/lib/authz";
import { parseFormSchema } from "@/lib/applications/schema";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { approveAction, denyAction, revokeAction, addNoteAction } from "./actions";
import { computeScore } from "@/lib/quality/score";
import { ALL_HEURISTICS, parseQualityConfig } from "@/lib/quality/registry";
import type { SignalsRaw } from "@/lib/quality/types";
import { countApprovingReviewers } from "@/lib/applications/decide";
import { getClaStatus } from "@/lib/cla/status";
import { FieldThread, type FieldThreadNote } from "./_components/field-thread";
import { NoteCard } from "./_components/note-card";
import { ReviewComposer, type DraftComment } from "./_components/review-composer";
import { ReviewsList, type ReviewListItem } from "./_components/reviews-list";

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
  const { session } = await requireProjectPermission(id, "project_applications_review");

  const app = await prisma.application.findFirst({
    where: { id: appId, projectId: id },
    include: {
      user: {
        select: {
          id: true,
          ghId: true,
          ghLogin: true,
          name: true,
          image: true,
          email: true,
        },
      },
      decidedBy: { select: { ghLogin: true } },
      project: {
        select: {
          id: true,
          formSchema: true,
          cooldownDays: true,
          qualityEnabled: true,
          qualityConfig: true,
          requireApprovalCount: true,
          claEnabled: true,
          claRequired: true,
        },
      },
      notes: {
        include: { author: { select: { id: true, ghLogin: true } } },
        orderBy: { createdAt: "asc" },
      },
      reviews: {
        include: { author: { select: { id: true, ghLogin: true } } },
        orderBy: { submittedAt: "asc" },
      },
    },
  });
  if (!app) notFound();

  const membership = await getProjectMembership(id, session.user.id);
  const viewerRole = (membership?.role ?? "REVIEWER") as Role;
  const canModerate = roleAtLeast(viewerRole, "ADMIN");

  const approvingReviewerCount = await countApprovingReviewers({
    applicationId: app.id,
    excludeUserId: session.user.id,
  });
  const requiredApprovals = app.project.requireApprovalCount;
  const gateMet = requiredApprovals === 0 || approvingReviewerCount >= requiredApprovals;

  // CLA gate: mirrors approveApplication's check (decide.ts). It only gates
  // when the project both enables AND requires the CLA. Record-only mode
  // (claEnabled, !claRequired) never blocks approval. An unlinked applicant
  // (no ghId/ghLogin) can't satisfy the CLA, so the gate stays unmet, exactly
  // as approveApplication treats it.
  const claGateActive = app.project.claEnabled && app.project.claRequired;
  const claStatus =
    claGateActive && app.user.ghId != null && app.user.ghLogin != null
      ? await getClaStatus({
          projectId: id,
          ghId: app.user.ghId,
          ghLogin: app.user.ghLogin,
        })
      : null;
  const claGateMet = !claGateActive || (claStatus?.satisfied ?? false);

  // Both the Approve and Re-approve forms post to approveApplication, which
  // enforces the same approval-count and CLA gates. Render the gate status and
  // disable the buttons proactively in both so a server-side gate throw never
  // reaches the global error boundary.
  const approvalGateNote =
    requiredApprovals > 0 ? (
      <p className="text-xs text-muted-foreground">
        Approval gate:{" "}
        <Badge
          variant={gateMet ? "success" : "warning"}
          className="ml-1 text-[10px]"
        >
          {approvingReviewerCount}/{requiredApprovals} approving review
          {requiredApprovals === 1 ? "" : "s"} from other reviewers
        </Badge>
        {!gateMet && (
          <span className="ml-1">Collect more LGTMs before approving.</span>
        )}
      </p>
    ) : null;

  // Status line shown in both the Approve and Re-approve forms when the CLA
  // gates approval. Wording mirrors the People overview CLA badges.
  const claGateNote = claGateActive ? (
    <p className="text-xs text-muted-foreground">
      CLA:{" "}
      <Badge
        variant={
          claGateMet
            ? "success"
            : claStatus?.needsResign
              ? "warning"
              : "destructive"
        }
        className="ml-1 text-[10px]"
      >
        {claGateMet
          ? "Signed"
          : claStatus?.needsResign
            ? "Re-sign required"
            : "Not signed"}
      </Badge>
      {claGateMet && claStatus?.via && (
        <Badge variant="outline" className="ml-1 text-[10px]">
          {claStatus.via === "icla"
            ? "Individual"
            : claStatus.via === "ccla"
              ? "Corporate"
              : "Waiver"}
        </Badge>
      )}
      {!claGateMet && (
        <span className="ml-1">
          Applicant must sign the CLA before approval.
        </span>
      )}
    </p>
  ) : null;

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
    if (!c.quality)
      return {
        prCheckId: c.id,
        repoFullName: c.repo.fullName,
        prNumber: c.prNumber,
        score: null as number | null,
      };
    const signals = JSON.parse(c.quality.signalsRaw) as SignalsRaw;
    const summary = computeScore(signals, qualityConfig);
    return {
      prCheckId: c.id,
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

  // Partition notes by their role:
  //  - field threads: anchored to a form field (fieldId set)
  //  - replies: parentId set (rendered nested under their parent)
  //  - general notes: unattached (legacy "Internal notes" card)
  // All visible to project members; the applicant only sees the
  // applicant-visible subset on /p/<slug>.
  const allNotes = app.notes as FieldThreadNote[];
  const fieldNotes = allNotes.filter((n) => n.fieldId !== null);
  const generalNotes = allNotes.filter(
    (n) => n.fieldId === null && n.parentId === null,
  );
  const generalReplies = allNotes.filter(
    (n) => n.fieldId === null && n.parentId !== null,
  );
  const generalRepliesByParent = new Map<string, FieldThreadNote[]>();
  for (const r of generalReplies) {
    if (!r.parentId) continue;
    const list = generalRepliesByParent.get(r.parentId) ?? [];
    list.push(r);
    generalRepliesByParent.set(r.parentId, list);
  }

  // Reviewer's own draft per-field comments (not yet attached to a review).
  const myDrafts: DraftComment[] = fieldNotes
    .filter(
      (n) =>
        n.author.id === session.user.id &&
        n.reviewId === null &&
        n.deletedAt === null &&
        n.parentId === null,
    )
    .map((n) => {
      const f = fields.find((x) => x.id === n.fieldId);
      return {
        id: n.id,
        fieldId: n.fieldId,
        fieldLabel: f?.label ?? null,
        bodyPreview:
          n.body.length > 80 ? n.body.slice(0, 77) + "…" : n.body,
      };
    });

  const reviewsListData: ReviewListItem[] = app.reviews.map((r) => ({
    id: r.id,
    state: r.state,
    body: r.body,
    visibility: r.visibility,
    submittedAt: r.submittedAt,
    deletedAt: r.deletedAt,
    author: { ghLogin: r.author.ghLogin },
    commentCount: fieldNotes.filter(
      (n) => n.reviewId === r.id && n.deletedAt === null,
    ).length,
  }));

  const viewer = {
    userId: session.user.id,
    canModerate,
    isApplicant: false,
  };

  const isPending = app.status === "SUBMITTED";
  const isApproved = app.status === "APPROVED";
  const isDenied = app.status === "DENIED";
  const cooldownDays = app.project.cooldownDays;
  const cooldownHelp =
    cooldownDays != null
      ? `Cooldown set to ${cooldownDays} day${cooldownDays === 1 ? "" : "s"}.`
      : `No cooldown configured. Applicant can resubmit immediately.`;

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
                        return typeof v === "string" && v.length > 0 ? v : "n/a";
                      })()}
                </div>
                <FieldThread
                  fieldId={f.id}
                  notes={fieldNotes}
                  projectId={id}
                  appId={app.id}
                  viewer={viewer}
                />
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
                  {approvalGateNote}
                  {claGateNote}
                  <SubmitButton
                    variant="success"
                    disabled={!gateMet || !claGateMet}
                  >
                    Approve
                  </SubmitButton>
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
                        {cooldownHelp}
                      </span>
                    </span>
                  </label>
                  <SubmitButton variant="destructive">Deny</SubmitButton>
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
                <SubmitButton variant="destructive">Revoke approval</SubmitButton>
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
                {approvalGateNote}
                {claGateNote}
                <SubmitButton
                  variant="success"
                  disabled={!gateMet || !claGateMet}
                >
                  Re-approve
                </SubmitButton>
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
                        <Link
                          className="font-mono text-xs underline"
                          href={`/dashboard/projects/${id}/prs?open=${p.prCheckId}`}
                        >
                          {p.repoFullName}#{p.prNumber}
                        </Link>
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
          <CardTitle className="text-base">Reviews</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ReviewsList
            reviews={reviewsListData}
            projectId={id}
            appId={app.id}
            canDismiss={canModerate}
          />
        </CardContent>
      </Card>

      {isPending && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Submit a review</CardTitle>
          </CardHeader>
          <CardContent>
            <ReviewComposer
              projectId={id}
              appId={app.id}
              drafts={myDrafts}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internal notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {generalNotes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notes yet. Notes are visible only to project members. Markdown
              is supported.
            </p>
          ) : (
            <ul className="space-y-3">
              {generalNotes.map((n) => (
                <li key={n.id} className="space-y-2">
                  <NoteCard
                    note={n}
                    projectId={id}
                    appId={app.id}
                    viewer={viewer}
                  />
                  {(generalRepliesByParent.get(n.id) ?? []).map((r) => (
                    <div key={r.id} className="ml-4">
                      <NoteCard
                        note={r}
                        projectId={id}
                        appId={app.id}
                        viewer={viewer}
                      />
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          <form action={addNoteAction} className="space-y-2">
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="appId" value={app.id} />
            <Textarea
              name="body"
              rows={2}
              required
              placeholder="Add a note for the team… (markdown supported)"
            />
            <SubmitButton size="sm" variant="outline">
              Post note
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
