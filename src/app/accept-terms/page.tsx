import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { SiteHeader } from "@/components/site-header";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/lib/env";
import { documentsToAccept, safeNext, termsVersions } from "@/lib/terms";
import { formatDate } from "@/lib/ui/format";
import { acceptTermsAction, deferTermsAction } from "./actions";

/**
 * The terms acceptance step (src/lib/terms.ts). Uses auth() directly, never
 * requireSession(), because requireSession() sends people here and would loop.
 *
 * Three texts, one screen: a new account accepts before it uses anything; an
 * account asked about an announced version may say "not now" until it binds;
 * an account behind on a version that binds may carry on read-only. The texts
 * are shown in full by link, beside the frozen copy of exactly the version
 * being accepted, and the page does not summarise what changed: the notice
 * mail did that.
 */
export default async function AcceptTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  const session = await auth();
  if (!session?.user) {
    redirect(
      `/handler/sign-in?after_auth_return_to=${encodeURIComponent(`/accept-terms?next=${next}`)}`,
    );
  }
  if (session.user.restricted) redirect("/restricted");
  if (!session.user.ghId) redirect("/welcome");

  const terms = session.user.terms;
  if (!terms || !["first", "asked", "restricted"].includes(terms.kind)) {
    redirect(next);
  }

  const documents = documentsToAccept(termsVersions(env.termsRollout), new Date());
  const binds = formatDate(terms.inForceFrom);

  const heading =
    terms.kind === "first"
      ? "Before you continue"
      : terms.kind === "asked"
        ? "Our terms are changing"
        : "Accept the current terms to continue";
  const intro =
    terms.kind === "first"
      ? "Contribution Checker is run by Gelhaus Solutions under its own terms and Gelhaus Solutions' general terms of service. Read both, then accept them to continue."
      : terms.kind === "asked"
        ? `New versions of the terms below take effect on ${binds}. You can accept them now, or choose "Not now" and keep using Contribution Checker as you do until then.`
        : "New versions of the terms below have taken effect. Until you accept them, your account is read-only: you can sign in and read, and nothing else.";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{heading}</CardTitle>
            <CardDescription>{intro}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ul className="space-y-3 text-sm">
              {documents.map((doc) => (
                <li key={doc.archiveUrl}>
                  <p className="font-medium">{doc.title}</p>
                  <p className="text-muted-foreground">
                    Version {doc.version}
                    {doc.inForce ? "" : `, in force from ${formatDate(doc.inForceFrom)}`}
                    {" · "}
                    <a className="text-primary underline-offset-4 hover:underline" href={doc.liveUrl}>
                      Read
                    </a>
                    {" · "}
                    <a className="text-primary underline-offset-4 hover:underline" href={doc.archiveUrl}>
                      Archived copy of this version
                    </a>
                  </p>
                </li>
              ))}
            </ul>
            {env.LEGAL_PRIVACY_URL ? (
              <p className="text-sm text-muted-foreground">
                How we handle your data is in the{" "}
                <a className="text-primary underline-offset-4 hover:underline" href={env.LEGAL_PRIVACY_URL}>
                  privacy notice
                </a>
                , which you read rather than accept. Exporting your data and your
                data-protection rights never depend on accepting: write to
                contact@gplatform.org.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <form action={acceptTermsAction}>
                <input type="hidden" name="record" value={terms.record} />
                <input type="hidden" name="next" value={next} />
                <SubmitButton size="sm">I accept these terms</SubmitButton>
              </form>
              {terms.kind === "first" ? (
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/" });
                  }}
                >
                  <SubmitButton size="sm" variant="outline">
                    Sign out
                  </SubmitButton>
                </form>
              ) : (
                <form action={deferTermsAction}>
                  <input type="hidden" name="next" value={next} />
                  <SubmitButton size="sm" variant="outline">
                    {terms.kind === "asked" ? "Not now" : "Continue read-only"}
                  </SubmitButton>
                </form>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
