"use client";

import { useEffect, useRef } from "react";
import { useUser } from "@hexclave/next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { finishOnboarding } from "./actions";

// Kept in sync with GITHUB_OAUTH_SCOPES in src/lib/stack.ts (which is
// server-only and cannot be imported here). These let the connected-account
// token read the numeric id, login, and primary email.
const GITHUB_SCOPES = ["read:user", "user:email"];

export function WelcomeClient({ error }: { error?: string }) {
  // Require a signed-in user, then force a GitHub connection with our scopes.
  // If the user signed up via email/Google/etc., this redirects them through
  // the GitHub OAuth flow (cookie write happens client-side, which a server
  // component can't do). Once connected, we finish onboarding server-side.
  const user = useUser({ or: "redirect" });
  user.useConnectedAccount("github", { or: "redirect", scopes: GITHUB_SCOPES });

  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  useEffect(() => {
    // Auto-complete once GitHub is connected. Skip on error so a failed run
    // doesn't loop; the user can click Continue to retry.
    if (submitted.current || error) return;
    submitted.current = true;
    formRef.current?.requestSubmit();
  }, [error]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Finishing setup</CardTitle>
        <CardDescription>
          Linking your GitHub identity. This only takes a moment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error === "github" && (
          <p className="mb-3 text-sm text-destructive">
            Something went wrong finishing setup. Click continue to retry.
          </p>
        )}
        <form ref={formRef} action={finishOnboarding}>
          <SubmitButton>Continue</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
