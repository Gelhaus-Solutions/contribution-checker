import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SiteHeader } from "@/components/site-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
        {/*
         * WelcomeClient uses Hexclave client hooks (useUser/useConnectedAccount
         * with `or: "redirect"`) that call suspendIfSsr() internally. For users
         * without GitHub connected (email/Google sign-ups) those hooks bail to
         * client-side rendering, which Next requires a Suspense boundary for;
         * without it the page 500s with NoSuspenseBoundaryError.
         */}
        <Suspense fallback={<WelcomeFallback />}>
          <WelcomeClient error={error} />
        </Suspense>
      </main>
    </>
  );
}

function WelcomeFallback() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Finishing setup</CardTitle>
        <CardDescription>
          Linking your GitHub identity. This only takes a moment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </CardContent>
    </Card>
  );
}
