import { notFound } from "next/navigation";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { prisma } from "@/lib/db";
import { parseFormSchema } from "@/lib/applications/schema";
import { SiteHeader } from "@/components/site-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApplyForm, type ClaEmbed } from "./apply-form";
import { AppealForm } from "./appeal-form";
import { applyAction, appealAction } from "./actions";
import { isManuallyBlocked } from "@/lib/applications/lifecycle";
import { getClaStatus } from "@/lib/cla/status";
import type { FormValue } from "@/components/form-renderer";
import { replyToCommentAction } from "@/app/dashboard/projects/[id]/applications/[appId]/actions";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  PENDING: "warning",
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
};

export default async function PublicProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      formSchema: true,
      allowAppeals: true,
      claEnabled: true,
      claRequired: true,
      claPlacementEmbed: true,
      claIclaRequireSignature: true,
      claIclaCustomFields: true,
      currentIclaVersionId: true,
      repos: {
        where: { active: true },
        select: { fullName: true },
        orderBy: { fullName: "asc" },
      },
    },
  });
  if (!project) notFound();

  const session = await auth();
  const fields = parseFormSchema(project.formSchema);

  // Embedded CLA: when the project requires a CLA in the application form and
  // the signed-in user is not already covered, surface the click-wrap block in
  // <ApplyForm>. Coverage is checked once here so an already-covered user (e.g.
  // signed standalone) never sees the block, so no double-signing. Bots and
  // unauthenticated visitors never reach this branch.
  let claEmbed: ClaEmbed | null = null;
  if (
    session?.user &&
    project.claEnabled &&
    project.claRequired &&
    project.claPlacementEmbed &&
    project.currentIclaVersionId &&
    typeof session.user.ghId === "number" &&
    session.user.ghLogin
  ) {
    const status = await getClaStatus({
      projectId: project.id,
      ghId: session.user.ghId,
      ghLogin: session.user.ghLogin,
    });
    if (!status.satisfied) {
      const version = await prisma.claDocumentVersion.findUnique({
        where: { id: project.currentIclaVersionId },
        select: {
          id: true,
          version: true,
          contentHash: true,
          bodyMarkdown: true,
          kind: true,
        },
      });
      if (version && version.kind === "ICLA") {
        claEmbed = {
          versionId: version.id,
          contentHash: version.contentHash,
          bodyMarkdown: version.bodyMarkdown,
          version: version.version,
          requireSignature: project.claIclaRequireSignature,
          customFields: parseFormSchema(project.claIclaCustomFields),
        };
      }
    }
  }

  const existing = session?.user
    ? await prisma.application.findFirst({
        where: { projectId: project.id, userId: session.user.id },
        orderBy: { createdAt: "desc" },
        include: {
          appeal: {
            select: { status: true, message: true, resolutionNote: true },
          },
        },
      })
    : null;

  // A manually DENIED contributor cannot apply or appeal (CLA signing on the
  // standalone /p/<slug>/cla page is unaffected).
  const blocked =
    session?.user != null &&
    (await isManuallyBlocked(project.id, session.user.id));

  // Applicant-visible feedback: review summaries with visibility=APPLICANT
  // plus their attached per-field comments and threaded applicant replies.
  // We deliberately keep INTERNAL items hidden: the applicant must never
  // see "LGTM" reviews or reviewer-only chatter.
  type FeedbackComment = {
    id: string;
    fieldId: string | null;
    parentId: string | null;
    body: string;
    createdAt: Date;
    deletedAt: Date | null;
    author: { id: string; ghLogin: string | null };
  };
  type FeedbackReview = {
    id: string;
    state: string;
    body: string | null;
    submittedAt: Date;
    deletedAt: Date | null;
    author: { ghLogin: string | null };
    comments: FeedbackComment[];
  };
  let feedback: FeedbackReview[] = [];
  if (existing) {
    const visibleReviews = await prisma.applicationReview.findMany({
      where: {
        applicationId: existing.id,
        visibility: "APPLICANT",
        deletedAt: null,
      },
      include: {
        author: { select: { ghLogin: true } },
        comments: {
          where: { deletedAt: null },
          include: {
            author: { select: { id: true, ghLogin: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { submittedAt: "asc" },
    });
    feedback = visibleReviews.map((r) => ({
      id: r.id,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
      deletedAt: r.deletedAt,
      author: { ghLogin: r.author.ghLogin },
      comments: r.comments.map((c) => ({
        id: c.id,
        fieldId: c.fieldId,
        parentId: c.parentId,
        body: c.body,
        createdAt: c.createdAt,
        deletedAt: c.deletedAt,
        author: { id: c.author.id, ghLogin: c.author.ghLogin },
      })),
    }));
  }
  const fieldsById = new Map(fields.map((f) => [f.id, f]));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="mt-2 text-muted-foreground">{project.description}</p>
          )}
          {project.repos.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {project.repos.map((r) => (
                <code
                  key={r.fullName}
                  className="rounded bg-muted px-2 py-1 font-mono"
                >
                  {r.fullName}
                </code>
              ))}
            </div>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Apply to contribute</CardTitle>
            <CardDescription>
              Fill out this form. Once approved, you&apos;ll be able to open
              pull requests on the linked repositories.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!session?.user ? (
              <form
                action={async () => {
                  "use server";
                  await signIn("github", {
                    redirectTo: `/p/${project.slug}`,
                  });
                }}
              >
                <SubmitButton>Login to apply</SubmitButton>
              </form>
            ) : blocked ? (
              <p className="text-sm text-muted-foreground">
                You are not eligible to contribute to this project.
              </p>
            ) : (
              <ApplicantSurface
                existing={existing}
                projectId={project.id}
                fields={fields}
                claEmbed={claEmbed}
                allowAppeals={project.allowAppeals}
              />
            )}
          </CardContent>
        </Card>

        {existing && feedback.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reviewer feedback</CardTitle>
              <CardDescription>
                Feedback from the project&apos;s reviewers. You can reply
                inline to clarify; this stays attached to your application.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {feedback.map((r) => (
                <ApplicantReviewBlock
                  key={r.id}
                  review={r}
                  fieldsById={fieldsById}
                  projectId={project.id}
                  applicationId={existing.id}
                />
              ))}
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Already applied?{" "}
          <Link href="/dashboard" className="underline">
            See your applications
          </Link>
          .
        </p>
      </main>
    </>
  );
}

function ApplicantReviewBlock({
  review,
  fieldsById,
  projectId,
  applicationId,
}: {
  review: {
    id: string;
    state: string;
    body: string | null;
    submittedAt: Date;
    author: { ghLogin: string | null };
    comments: Array<{
      id: string;
      fieldId: string | null;
      parentId: string | null;
      body: string;
      createdAt: Date;
      author: { id: string; ghLogin: string | null };
    }>;
  };
  fieldsById: Map<string, { label: string }>;
  projectId: string;
  applicationId: string;
}) {
  const top = review.comments.filter((c) => c.parentId === null);
  const repliesByParent = new Map<string, typeof top>();
  for (const c of review.comments) {
    if (c.parentId) {
      const list = repliesByParent.get(c.parentId) ?? [];
      list.push(c);
      repliesByParent.set(c.parentId, list);
    }
  }
  const stateLabel =
    review.state === "CHANGES_REQUESTED"
      ? "Changes requested"
      : review.state === "COMMENTED"
        ? "Comment"
        : review.state;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge
          variant={
            review.state === "CHANGES_REQUESTED" ? "warning" : "secondary"
          }
          className="text-[10px]"
        >
          {stateLabel}
        </Badge>
        <span className="font-medium">@{review.author.ghLogin ?? "reviewer"}</span>
        <span className="text-muted-foreground">
          {review.submittedAt.toISOString().slice(0, 10)}
        </span>
      </div>
      {review.body && <Markdown source={review.body} />}
      {top.length > 0 && (
        <ul className="space-y-3">
          {top.map((c) => (
            <li key={c.id} className="space-y-2">
              {c.fieldId && fieldsById.has(c.fieldId) && (
                <p className="text-xs text-muted-foreground">
                  on{" "}
                  <span className="font-medium">
                    {fieldsById.get(c.fieldId)!.label}
                  </span>
                </p>
              )}
              <div className="rounded-md border border-border bg-background p-2 text-sm">
                <div className="mb-1 text-xs text-muted-foreground">
                  @{c.author.ghLogin ?? "reviewer"} ·{" "}
                  {c.createdAt.toISOString().slice(0, 10)}
                </div>
                <Markdown source={c.body} />
              </div>
              {(repliesByParent.get(c.id) ?? []).map((rp) => (
                <div
                  key={rp.id}
                  className="ml-4 rounded-md border border-border bg-background p-2 text-sm"
                >
                  <div className="mb-1 text-xs text-muted-foreground">
                    @{rp.author.ghLogin ?? "you"} ·{" "}
                    {rp.createdAt.toISOString().slice(0, 10)}
                  </div>
                  <Markdown source={rp.body} />
                </div>
              ))}
              <form
                action={replyToCommentAction}
                className="ml-4 space-y-1"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="appId" value={applicationId} />
                <input type="hidden" name="parentId" value={c.id} />
                <Textarea
                  name="body"
                  rows={2}
                  required
                  placeholder="Reply… (markdown supported)"
                  className="text-sm"
                />
                <SubmitButton size="sm" variant="outline">
                  Reply
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ApplicantExisting = {
  id: string;
  status: string;
  createdAt: Date;
  reason: string | null;
  answers: string;
  allowResubmit: boolean;
  cooldownUntil: Date | null;
  appeal: {
    status: string;
    message: string;
    resolutionNote: string | null;
  } | null;
};

type ApplicantView = {
  derivedStatus: "SUBMITTED" | "APPROVED" | "DENIED" | "PENDING";
  info: React.ReactNode;
  canApply: boolean;
  canAppeal: boolean;
};

/** Parse a stored answers JSON blob into FormRenderer-friendly values. */
function parseAnswerValues(answers: string): Record<string, FormValue> {
  try {
    const obj = JSON.parse(answers);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, FormValue> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function ApplicantSurface({
  existing,
  projectId,
  fields,
  claEmbed,
  allowAppeals,
}: {
  existing: ApplicantExisting | null;
  projectId: string;
  fields: ReturnType<typeof parseFormSchema>;
  claEmbed: ClaEmbed | null;
  allowAppeals: boolean;
}) {
  if (!existing) {
    return (
      <ApplyForm
        projectId={projectId}
        fields={fields}
        action={applyAction}
        claEmbed={claEmbed}
      />
    );
  }
  const view = deriveApplicantView(existing, allowAppeals);
  return (
    <div className="space-y-4">
      <ExistingApplication derivedStatus={view.derivedStatus} info={view.info} />
      {view.canAppeal && (
        <div className="space-y-3 rounded-md border border-border p-4">
          <div>
            <h3 className="text-sm font-semibold">Appeal this decision</h3>
            <p className="text-xs text-muted-foreground">
              Make your case to the reviewers. You can also revise your answers.
              You may appeal once.
            </p>
          </div>
          <AppealForm
            applicationId={existing.id}
            fields={fields}
            initialValues={parseAnswerValues(existing.answers)}
            action={appealAction}
          />
        </div>
      )}
      {view.canApply && (
        <ApplyForm
          projectId={projectId}
          fields={fields}
          action={applyAction}
          claEmbed={claEmbed}
        />
      )}
    </div>
  );
}

function deriveApplicantView(
  existing: ApplicantExisting,
  allowAppeals: boolean,
): ApplicantView {
  if (existing.status === "SUBMITTED") {
    return {
      derivedStatus: "SUBMITTED",
      info: (
        <p className="text-sm">
          Your application was submitted on{" "}
          {existing.createdAt.toISOString().slice(0, 10)} and is awaiting review.
        </p>
      ),
      canApply: false,
      canAppeal: false,
    };
  }
  if (existing.status === "APPROVED") {
    return {
      derivedStatus: "APPROVED",
      info: (
        <p className="text-sm">
          You&apos;re approved. You can open pull requests on the linked
          repositories.
        </p>
      ),
      canApply: false,
      canAppeal: false,
    };
  }
  // DENIED
  const appeal = existing.appeal;
  const reasonNode = existing.reason ? (
    <p>
      <strong>Reason:</strong> {existing.reason}
    </p>
  ) : null;

  if (appeal?.status === "PENDING") {
    return {
      derivedStatus: "DENIED",
      info: (
        <div className="space-y-2 text-sm">
          <p>Your application was declined.</p>
          {reasonNode}
          <p>Your appeal was submitted and is under review.</p>
          {appeal.message && (
            <div className="rounded-md border border-border bg-muted/20 p-2">
              <div className="text-xs text-muted-foreground">Your appeal</div>
              {appeal.message}
            </div>
          )}
        </div>
      ),
      canApply: false,
      canAppeal: false,
    };
  }

  const appealRejectedNode =
    appeal?.status === "REJECTED" ? (
      <div className="rounded-md border border-border bg-muted/20 p-2">
        <p>Your appeal was declined.</p>
        {appeal.resolutionNote && (
          <p>
            <strong>Note:</strong> {appeal.resolutionNote}
          </p>
        )}
      </div>
    ) : null;

  // One appeal per application: only offer it when the project allows appeals
  // and the applicant has not appealed yet.
  const canAppeal = allowAppeals && !appeal;

  if (!existing.allowResubmit) {
    return {
      derivedStatus: "DENIED",
      info: (
        <div className="space-y-2 text-sm">
          <p>Your application was declined.</p>
          {reasonNode}
          {appealRejectedNode}
          <p>
            Re-applying is disabled.{" "}
            {canAppeal
              ? "You may appeal this decision below."
              : "Contact a project admin if you believe this is in error."}
          </p>
        </div>
      ),
      canApply: false,
      canAppeal,
    };
  }
  if (existing.cooldownUntil && existing.cooldownUntil > new Date()) {
    return {
      derivedStatus: "DENIED",
      info: (
        <div className="space-y-2 text-sm">
          <p>Your application was declined.</p>
          {reasonNode}
          {appealRejectedNode}
          <p>
            You can re-apply on{" "}
            {existing.cooldownUntil.toISOString().slice(0, 10)}.
          </p>
        </div>
      ),
      canApply: false,
      canAppeal,
    };
  }
  // Derived PENDING: previous denial, resubmit allowed and cooldown elapsed.
  return {
    derivedStatus: "PENDING",
    info: (
      <div className="space-y-2 text-sm">
        <p>Your previous application was declined.</p>
        {reasonNode}
        {appealRejectedNode}
        <p>You may submit a new application below.</p>
      </div>
    ),
    canApply: true,
    canAppeal,
  };
}

function ExistingApplication({
  derivedStatus,
  info,
}: {
  derivedStatus: ApplicantView["derivedStatus"];
  info: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[derivedStatus] ?? "secondary"}>
          {derivedStatus}
        </Badge>
      </div>
      {info}
    </div>
  );
}
