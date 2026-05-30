import { notFound } from "next/navigation";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { prisma } from "@/lib/db";
import { getClaStatus } from "@/lib/cla/status";
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
import { SignForm, DisputeForm } from "./sign-form";
import { signIcla, disputeMembership } from "./actions";

export default async function ClaSignPage({
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
      claIclaRequireSignature: true,
      claIclaCustomFields: true,
      currentIclaVersionId: true,
    },
  });
  if (!project) notFound();

  const session = await auth();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {project.name}: Contributor License Agreement
          </h1>
          <p className="mt-2 text-muted-foreground">
            Sign the CLA to have your contributions accepted. Your pull requests
            stay open and re-check automatically once you&apos;ve signed.
          </p>
        </div>

        {!project.claEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No CLA required</CardTitle>
              <CardDescription>
                This project does not require a Contributor License Agreement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={`/p/${project.slug}`} className="text-sm underline">
                Back to the project
              </Link>
            </CardContent>
          </Card>
        ) : !session?.user ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sign in to continue</CardTitle>
              <CardDescription>
                A CLA must be tied to an authenticated GitHub identity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                action={async () => {
                  "use server";
                  await signIn("github", {
                    redirectTo: `/p/${project.slug}/cla`,
                  });
                }}
              >
                <SubmitButton>Sign in with GitHub to sign the CLA</SubmitButton>
              </form>
            </CardContent>
          </Card>
        ) : (
          <ClaSurface
            project={project}
            user={{
              id: session.user.id,
              ghId: session.user.ghId ?? null,
              ghLogin: session.user.ghLogin ?? null,
            }}
          />
        )}
      </main>
    </>
  );
}

async function ClaSurface({
  project,
  user,
}: {
  project: {
    id: string;
    slug: string;
    name: string;
    claEnabled: boolean;
    claCorporateEnabled: boolean;
    claIclaRequireSignature: boolean;
    claIclaCustomFields: string;
    currentIclaVersionId: string | null;
  };
  user: { id: string; ghId: number | null; ghLogin: string | null };
}) {
  if (typeof user.ghId !== "number" || !user.ghLogin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub identity missing</CardTitle>
          <CardDescription>
            We couldn&apos;t resolve your GitHub identity. Sign out and back in,
            then try again.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const ghId = user.ghId;
  const ghLogin = user.ghLogin;

  const status = await getClaStatus({
    projectId: project.id,
    ghId,
    ghLogin,
  });

  // Already covered by an individual signature (current version) or a waiver.
  if (status.satisfied && status.via !== "ccla") {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge variant="success">Signed</Badge>
            <CardTitle className="text-base">You&apos;re covered</CardTitle>
          </div>
          <CardDescription>
            {status.via === "waiver"
              ? "A maintainer has granted you a CLA exemption for this project."
              : "Your Contributor License Agreement is on file and up to date."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Link href={`/p/${project.slug}`} className="text-sm underline">
            Back to the project
          </Link>
          {project.claCorporateEnabled && (
            <p className="text-xs text-muted-foreground">
              Signing on behalf of a company?{" "}
              <Link
                href={`/p/${project.slug}/cla/corporate`}
                className="underline"
              >
                Sign a Corporate CLA
              </Link>{" "}
              as well.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Covered by a corporate CLA: offer the exemption/dispute path.
  if (status.satisfied && status.via === "ccla" && status.corporate) {
    const member = await prisma.cclaRosterMember.findFirst({
      where: {
        corporateId: status.corporate.id,
        status: "ACTIVE",
        OR: [{ ghId }, { ghLogin: ghLogin.toLowerCase() }],
      },
      select: { id: true },
    });
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge variant="success">Covered</Badge>
            <CardTitle className="text-base">
              Covered by {status.corporate.companyName}
            </CardTitle>
          </div>
          <CardDescription>
            Your contributions are covered under the Corporate CLA signed by{" "}
            {status.corporate.companyName}. If that&apos;s not right, you can
            request an exemption. Your coverage will be suspended and you can
            sign individually instead.
          </CardDescription>
        </CardHeader>
        {member && (
          <CardContent>
            <DisputeForm
              memberId={member.id}
              companyName={status.corporate.companyName}
              action={disputeMembership}
            />
          </CardContent>
        )}
      </Card>
    );
  }

  // Needs to sign (or re-sign a now-stale version). Load the current ICLA text.
  const version = project.currentIclaVersionId
    ? await prisma.claDocumentVersion.findUnique({
        where: { id: project.currentIclaVersionId },
        select: {
          id: true,
          version: true,
          contentHash: true,
          bodyMarkdown: true,
          kind: true,
        },
      })
    : null;

  if (!version || version.kind !== "ICLA") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLA not yet available</CardTitle>
          <CardDescription>
            The maintainers have enabled the CLA but haven&apos;t published the
            agreement text yet. Check back shortly.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const mustReSign = status.needsResign === true;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant="warning">{mustReSign ? "Re-sign" : "Action required"}</Badge>
          <CardTitle className="text-base">
            {mustReSign ? "Please re-sign the updated CLA" : "Sign the CLA"}
          </CardTitle>
        </div>
        <CardDescription>
          {mustReSign
            ? "The agreement has been updated and requires a new signature. Read the current version below and sign to restore coverage."
            : "Read the agreement below, then type your full legal name and sign."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignForm
          projectId={project.id}
          versionId={version.id}
          contentHash={version.contentHash}
          bodyMarkdown={version.bodyMarkdown}
          ghLogin={ghLogin}
          requireSignature={project.claIclaRequireSignature}
          customFields={parseFormSchema(project.claIclaCustomFields)}
          action={signIcla}
        />
        {project.claCorporateEnabled && (
          <p className="mt-4 text-xs text-muted-foreground">
            Signing on behalf of a company?{" "}
            <Link
              href={`/p/${project.slug}/cla/corporate`}
              className="underline"
            >
              Sign a Corporate CLA
            </Link>{" "}
            instead.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
