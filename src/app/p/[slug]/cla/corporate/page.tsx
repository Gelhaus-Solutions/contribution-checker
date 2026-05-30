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
                Sign in with GitHub to sign or manage a corporate CLA.
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
                <SubmitButton>Sign in with GitHub</SubmitButton>
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
  // Does the signed-in user already manage a CCLA for this project? The
  // signatory's ClaSignature is FK'd to the CorporateCla; we match on the
  // signing user. Only ACTIVE corporates are manageable.
  const managed = await prisma.corporateCla.findFirst({
    where: {
      projectId,
      status: "ACTIVE",
      signature: { userId },
    },
    select: {
      id: true,
      companyName: true,
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

  if (managed) {
    const members: RosterMember[] = managed.members.map((m) => ({
      id: m.id,
      ghLogin: m.ghLogin,
      ghId: m.ghId,
      status: m.status,
      disputeNote: m.disputeNote,
      addedAt: m.addedAt.toISOString().slice(0, 10),
    }));
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Roster: {managed.companyName}
          </CardTitle>
          <CardDescription>
            Contributors listed here are covered by your corporate CLA. Their
            open pull requests are re-checked automatically when you add them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RosterManager
            corporateId={managed.id}
            companyName={managed.companyName}
            members={members}
            addAction={addRosterMembers}
            revokeAction={revokeRosterMember}
          />
        </CardContent>
      </Card>
    );
  }

  // No corporate yet, so show the CCLA sign form.
  const version = currentCclaVersionId
    ? await prisma.claDocumentVersion.findUnique({
        where: { id: currentCclaVersionId },
        select: { bodyMarkdown: true, version: true, contentHash: true },
      })
    : null;

  if (!version) {
    return (
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
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Sign the Corporate CLA (v{version.version})
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
  );
}
