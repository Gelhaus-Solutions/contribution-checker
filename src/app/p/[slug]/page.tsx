import { notFound } from "next/navigation";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { prisma } from "@/lib/db";
import { parseFormSchema } from "@/lib/applications/schema";
import { SiteHeader } from "@/components/site-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApplyForm } from "./apply-form";
import { applyAction } from "./actions";

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

  const existing = session?.user
    ? await prisma.application.findFirst({
        where: { projectId: project.id, userId: session.user.id },
        orderBy: { createdAt: "desc" },
      })
    : null;

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
                <SubmitButton>Sign in with GitHub to apply</SubmitButton>
              </form>
            ) : (
              <ApplicantSurface
                existing={existing}
                projectId={project.id}
                fields={fields}
              />
            )}
          </CardContent>
        </Card>

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

type ApplicantExisting = {
  status: string;
  createdAt: Date;
  reason: string | null;
  allowResubmit: boolean;
  cooldownUntil: Date | null;
};

type ApplicantView = {
  derivedStatus: "SUBMITTED" | "APPROVED" | "DENIED" | "PENDING";
  info: React.ReactNode;
  canApply: boolean;
};

function ApplicantSurface({
  existing,
  projectId,
  fields,
}: {
  existing: ApplicantExisting | null;
  projectId: string;
  fields: ReturnType<typeof parseFormSchema>;
}) {
  if (!existing) {
    return (
      <ApplyForm projectId={projectId} fields={fields} action={applyAction} />
    );
  }
  const view = deriveApplicantView(existing);
  return (
    <div className="space-y-4">
      <ExistingApplication derivedStatus={view.derivedStatus} info={view.info} />
      {view.canApply && (
        <ApplyForm projectId={projectId} fields={fields} action={applyAction} />
      )}
    </div>
  );
}

function deriveApplicantView(existing: ApplicantExisting): ApplicantView {
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
    };
  }
  // DENIED
  if (!existing.allowResubmit) {
    return {
      derivedStatus: "DENIED",
      info: (
        <div className="space-y-2 text-sm">
          <p>Your application was declined.</p>
          {existing.reason && (
            <p>
              <strong>Reason:</strong> {existing.reason}
            </p>
          )}
          <p>
            Re-applying is disabled. Contact a project admin if you believe
            this is in error.
          </p>
        </div>
      ),
      canApply: false,
    };
  }
  if (existing.cooldownUntil && existing.cooldownUntil > new Date()) {
    return {
      derivedStatus: "DENIED",
      info: (
        <div className="space-y-2 text-sm">
          <p>Your application was declined.</p>
          {existing.reason && (
            <p>
              <strong>Reason:</strong> {existing.reason}
            </p>
          )}
          <p>
            You can re-apply on{" "}
            {existing.cooldownUntil.toISOString().slice(0, 10)}.
          </p>
        </div>
      ),
      canApply: false,
    };
  }
  // Derived PENDING: previous denial, resubmit allowed and cooldown elapsed.
  return {
    derivedStatus: "PENDING",
    info: (
      <div className="space-y-2 text-sm">
        <p>Your previous application was declined.</p>
        {existing.reason && (
          <p>
            <strong>Reason:</strong> {existing.reason}
          </p>
        )}
        <p>You may submit a new application below.</p>
      </div>
    ),
    canApply: true,
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
