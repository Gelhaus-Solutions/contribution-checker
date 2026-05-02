import { notFound } from "next/navigation";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { prisma } from "@/lib/db";
import { parseFormSchema } from "@/lib/applications/schema";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
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
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
  REVOKED: "secondary",
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
      cooldownDays: true,
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
                <Button type="submit">Sign in with GitHub to apply</Button>
              </form>
            ) : existing ? (
              <ExistingApplication
                status={existing.status}
                createdAt={existing.createdAt}
                cooldownDays={project.cooldownDays}
                decidedAt={existing.decidedAt}
                reason={existing.reason}
              />
            ) : (
              <ApplyForm
                projectId={project.id}
                fields={fields}
                action={applyAction}
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

function ExistingApplication({
  status,
  createdAt,
  cooldownDays,
  decidedAt,
  reason,
}: {
  status: string;
  createdAt: Date;
  cooldownDays: number | null;
  decidedAt: Date | null;
  reason: string | null;
}) {
  let body: React.ReactNode = null;

  if (status === "SUBMITTED") {
    body = (
      <p className="text-sm">
        Your application was submitted on{" "}
        {createdAt.toISOString().slice(0, 10)} and is awaiting review.
      </p>
    );
  } else if (status === "APPROVED") {
    body = (
      <p className="text-sm">
        You&apos;re approved. You can open pull requests on the linked
        repositories.
      </p>
    );
  } else if (status === "DENIED") {
    const cooldownEnd =
      cooldownDays && decidedAt
        ? new Date(decidedAt.getTime() + cooldownDays * 86400000)
        : null;
    body = (
      <div className="space-y-2 text-sm">
        <p>Your application was declined.</p>
        {reason && (
          <p>
            <strong>Reason:</strong> {reason}
          </p>
        )}
        {cooldownEnd && cooldownEnd > new Date() ? (
          <p>You can re-apply on {cooldownEnd.toISOString().slice(0, 10)}.</p>
        ) : cooldownDays === null ? (
          <p>Re-applying is disabled. Contact a project admin if you believe this is in error.</p>
        ) : (
          <p>You can re-apply now.</p>
        )}
      </div>
    );
  } else if (status === "REVOKED") {
    body = (
      <p className="text-sm">
        Your access was revoked. You may submit a new application below.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{status}</Badge>
      </div>
      {body}
    </div>
  );
}
