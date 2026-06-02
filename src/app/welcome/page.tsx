import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getStackServerApp } from "@/lib/stack";
import { isValidCountryCode } from "@/lib/countries";
import { SiteHeader } from "@/components/site-header";
import { WelcomeClient } from "./welcome-client";

/**
 * Post-login onboarding interstitial. Enforced for protected routes by
 * requireSession() (redirects here until ghId + country are set). Forces a
 * GitHub connection (client-side) and collects the country code.
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
  // Already fully onboarded -> dashboard.
  if (session.user.ghId && session.user.country) {
    redirect("/dashboard");
  }

  const stackApp = await getStackServerApp();
  const stackUser = await stackApp.getUser();
  // Pre-fill from Hexclave's best-effort geo country code, if valid.
  const geo = (stackUser?.countryCode ?? "").toUpperCase();
  const defaultCountry = isValidCountryCode(geo) ? geo : "";

  const { error } = await searchParams;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md p-6">
        <WelcomeClient defaultCountry={defaultCountry} error={error} />
      </main>
    </>
  );
}
