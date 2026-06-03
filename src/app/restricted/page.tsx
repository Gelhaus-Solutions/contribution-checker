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

/**
 * Shown to users an administrator has restricted in Stack Auth. Uses auth()
 * DIRECTLY (never requireSession) so it can't redirect-loop into itself:
 * requireSession() and the per-action guards send restricted users here, and a
 * non-restricted visitor is bounced back to /dashboard. The only action offered
 * is sign-out.
 */
export default async function RestrictedPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/handler/sign-in?after_auth_return_to=/restricted");
  }
  // Not actually restricted -> this page has nothing to say to them.
  if (!session.user.restricted) {
    redirect("/dashboard");
  }

  const reason = session.user.restrictionReason;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account restricted</CardTitle>
            <CardDescription>
              An administrator has restricted your access to this application.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {reason ??
                "No reason was provided. Contact the administrator for details."}
            </p>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <SubmitButton size="sm">Sign out</SubmitButton>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
