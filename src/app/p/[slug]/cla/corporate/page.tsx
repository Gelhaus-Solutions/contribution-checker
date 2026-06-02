import { notFound } from "next/navigation";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { prisma } from "@/lib/db";
import { SiteHeader } from "@/components/site-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { Markdown } from "@/components/markdown";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SignCclaForm } from "./sign-ccla-form";
import { RosterManager, type RosterMember } from "./roster";
import { signCcla, addRosterMembers, revokeRosterMember } from "../actions";
import { parseFormSchema, type FormSchema } from "@/lib/applications/schema";

export default async function CorporateClaPage({
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
      claEnabled: true,
      claRequired: true,
      claCorporateEnabled: true,
      claCclaCustomFields: true,
      currentCclaVersionId: true,
    },
  });
  if (!project) notFound();
  // Corporate CLA must be enabled (and CLA itself on) for this page to exist.
  if (!project.claEnabled || !project.claCorporateEnabled) notFound();

  const session = await auth();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Corporate CLA: {project.name}
          </h1>
          <p className="mt-2 text-muted-foreground">
            Sign a Corporate Contributor License Agreement on behalf of your
            company and manage the contributors it covers.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            <Link href={`/p/${project.slug}/cla`} className="underline">
              Looking to sign as an individual instead?
            </Link>
          </p>
        </div>

        {!session?.user ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sign in required</CardTitle>
              <CardDescription>
                Log in to sign or manage a corporate CLA.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                action={async () => {
                  "use server";
                  await signIn("github", {
                    redirectTo: `/p/${project.slug}/cla/corporate`,
                  });
                }}
              >
                <SubmitButton>Login</SubmitButton>
              </form>
            </CardContent>
          </Card>
        ) : (
          <CorporateSurface
            projectId={project.id}
            userId={session.user.id}
            currentCclaVersionId={project.currentCclaVersionId}
            cclaCustomFields={parseFormSchema(project.claCclaCustomFields)}
          />
        )}
      </main>
    </>
  );
}

function cclaStatusBadge(status: string) {
  switch (status) {
    case "ACTIVE":
      return <Badge variant="success">Active</Badge>;
    case "PENDING":
      return <Badge variant="warning">Pending approval</Badge>;
    case "REJECTED":
      return <Badge variant="destructive">Rejected</Badge>;
    case "REVOKED":
      return <Badge variant="secondary">Revoked</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

async function CorporateSurface({
  projectId,
  userId,
  currentCclaVersionId,
  cclaCustomFields,
}: {
  projectId: string;
  userId: string;
  currentCclaVersionId: string | null;
  cclaCustomFields: FormSchema;
}) {
  // Every CCLA the signed-in user has signed for this project, newest first. A
  // user can hold several (multiple legal entities, or re-signs), each at its
  // own point in the approval lifecycle. The signatory's ClaSignature is FK'd to
  // the CorporateCla; we match on the signing user.
  const managed = await prisma.corporateCla.findMany({
    where: { projectId, signature: { userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      companyName: true,
      status: true,
      rejectReason: true,
      members: {
        orderBy: { addedAt: "desc" },
        select: {
          id: true,
          ghLogin: true,
          ghId: true,
          status: true,
          disputeNote: true,
          addedAt: true,
        },
      },
    },
  });

  const version = currentCclaVersionId
    ? await prisma.claDocumentVersion.findUnique({
        where: { id: currentCclaVersionId },
        select: { bodyMarkdown: true, version: true, contentHash: true },
      })
    : null;

  return (
    <div className="space-y-6">
      {managed.map((c) => {
        const manageable = c.status === "ACTIVE" || c.status === "PENDING";
        const members: RosterMember[] = c.members.map((m) => ({
          id: m.id,
          ghLogin: m.ghLogin,
          ghId: m.ghId,
          status: m.status,
          disputeNote: m.disputeNote,
          addedAt: m.addedAt.toISOString().slice(0, 10),
        }));
        return (
          <Card key={c.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                {cclaStatusBadge(c.status)}
                <CardTitle className="text-base">
                  Roster: {c.companyName}
                </CardTitle>
              </div>
              <CardDescription>
                {c.status === "PENDING"
                  ? "Pending admin approval. Add the GitHub usernames it covers now; coverage applies once an admin approves this corporate CLA."
                  : c.status === "ACTIVE"
                    ? "Contributors listed here are covered by your corporate CLA. Their open pull requests are re-checked automatically when you add them."
                    : c.status === "REJECTED"
                      ? `An admin rejected this corporate CLA.${c.rejectReason ? ` Reason: ${c.rejectReason}` : ""}`
                      : "This corporate CLA has been revoked and no longer covers its roster."}
              </CardDescription>
            </CardHeader>
            {manageable && (
              <CardContent>
                <RosterManager
                  corporateId={c.id}
                  companyName={c.companyName}
                  members={members}
                  addAction={addRosterMembers}
                  revokeAction={revokeRosterMember}
                />
              </CardContent>
            )}
          </Card>
        );
      })}

      {version ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {managed.length > 0
                ? `Sign another Corporate CLA (v${version.version})`
                : `Sign the Corporate CLA (v${version.version})`}
            </CardTitle>
            <CardDescription>
              Read the agreement, then sign on behalf of your company. After
              signing you&apos;ll be able to add the GitHub usernames it covers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
              <Markdown source={version.bodyMarkdown} />
            </div>
            <SignCclaForm
              projectId={projectId}
              customFields={cclaCustomFields}
              action={signCcla}
            />
          </CardContent>
        </Card>
      ) : (
        managed.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Corporate CLA</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                The project hasn&apos;t published a corporate CLA document yet.
                Check back later or contact a project admin.
              </p>
            </CardContent>
          </Card>
        )
      )}
    </div>
  );
}
