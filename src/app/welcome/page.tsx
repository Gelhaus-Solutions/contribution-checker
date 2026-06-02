import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SiteHeader } from "@/components/site-header";
import { WelcomeClient } from "./welcome-client";

/**
 * Post-login onboarding interstitial. Enforced for protected routes by
 * requireSession() (redirects here until the GitHub identity is linked). Forces
 * a GitHub connection (client-side) and then completes onboarding server-side:
 * binds ghId/ghLogin, reconciles permissions, and captures the country code in
 * the background (no user prompt).
 *
 * Uses auth() directly (never requireSession) so it can't redirect-loop into
 * itself.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/handler/sign-in?after_auth_return_to=/welcome");
  }
  // GitHub already linked -> onboarding is done.
  if (session.user.ghId) {
    redirect("/dashboard");
  }

  const { error } = await searchParams;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md p-6">
        <WelcomeClient error={error} />
      </main>
    </>
  );
}
