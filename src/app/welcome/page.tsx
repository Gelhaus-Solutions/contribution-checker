import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signInUrl } from "@/auth";
import { signInPath } from "@/lib/authz";
import { safeNextPath } from "@/lib/auth/next-path";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The onboarding gate's landing. requireSession() sends a person here while
 * their account has no GitHub identity (ghId). Signing in with GitHub through
 * GPID fills it on the way in (auth() takes it from GPID's link), so this is
 * reached only by an account whose GPID sign-in carries no GitHub link: it
 * asks for the GitHub sign-in, which links it.
 *
 * Uses auth() directly (never requireSession) so it can't redirect-loop into
 * itself. `next` brings the person back where they came from (the project
 * they were applying to) instead of the dashboard.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: asked } = await searchParams;
  const next = safeNextPath(asked);
  const here = next === null ? "/welcome" : `/welcome?next=${encodeURIComponent(next)}`;
  const session = await auth();
  if (!session?.user) redirect(await signInPath(here));
  if (session.user.restricted) redirect("/restricted");
  // GitHub already linked -> onboarding is done.
  if (session.user.ghId) {
    redirect(next ?? "/dashboard");
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Finishing setup</CardTitle>
            <CardDescription>
              Contribution Checker needs your GitHub account. Sign in with GitHub once to link it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={signInUrl(next ?? "/dashboard")}>Continue with GitHub</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
