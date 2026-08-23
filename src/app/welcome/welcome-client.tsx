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

// Kept in sync with GITHUB_PROVIDER_CONFIG_ID / GITHUB_OAUTH_SCOPES in
// src/lib/auth/constants.ts (imported there by server-only modules; duplicated
// here so this client component pulls in no server code).
const GITHUB_PROVIDER = "github";
const GITHUB_SCOPES = ["read:user", "user:email"];

export function WelcomeClient({ error }: { error?: string }) {
  // Require a signed-in user, then make sure a GitHub provider is LINKED.
  //
  // This deliberately does not use `useConnectedAccount("github", { or:
  // "redirect" })`. That hook resolves a connected-account ACCESS TOKEN, and
  // Hexclave never issues one when its GitHub provider runs on shared OAuth
  // keys: the token call fails, the hook concludes the account is not
  // connected, and with `or: "redirect"` it bounced the user back through
  // GitHub forever, or threw out of the render into the route error boundary
  // ("Something went wrong"). Either way sign-up was impossible.
  //
  // finishOnboarding does not need a token either: syncGitHubIdentity reads the
  // numeric id from the provider link's accountId and resolves the public
  // profile by id. So the link itself is the only thing worth checking, and
  // useOAuthProviders() reports it without touching the token endpoint.
  const user = useUser({ or: "redirect" });
  const providers = user.useOAuthProviders();
  const linked = providers.some((p) => p.type === GITHUB_PROVIDER);

  // Email/Google sign-ups arrive here with no GitHub link. Send them through
  // the OAuth flow once; linkConnectedAccount redirects and never returns.
  const linking = useRef(false);
  useEffect(() => {
    if (linked || linking.current) return;
    linking.current = true;
    void user.linkConnectedAccount(GITHUB_PROVIDER, { scopes: GITHUB_SCOPES });
  }, [linked, user]);

  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  useEffect(() => {
    // Auto-complete once GitHub is linked. Skip on error so a failed run
    // doesn't loop; the user can click Continue to retry.
    if (!linked || submitted.current || error) return;
    submitted.current = true;
    formRef.current?.requestSubmit();
  }, [linked, error]);

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
