"use client";

import { useUser } from "@hexclave/next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { COUNTRIES } from "@/lib/countries";
import { finishOnboarding } from "./actions";

// Kept in sync with GITHUB_OAUTH_SCOPES in src/lib/stack.ts (which is
// server-only and cannot be imported here). These let the connected-account
// token read the numeric id, login, and primary email.
const GITHUB_SCOPES = ["read:user", "user:email"];

export function WelcomeClient({
  defaultCountry,
  error,
}: {
  defaultCountry: string;
  error?: string;
}) {
  // Require a signed-in user, then force a GitHub connection with our scopes.
  // If the user signed up via email/Google/etc., this redirects them through
  // the GitHub OAuth flow before the country step is shown.
  const user = useUser({ or: "redirect" });
  user.useConnectedAccount("github", { or: "redirect", scopes: GITHUB_SCOPES });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Finish setting up your account</CardTitle>
        <CardDescription>
          Your GitHub identity is linked. Select your country to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error === "country" && (
          <p className="mb-3 text-sm text-destructive">
            Please choose a valid country.
          </p>
        )}
        {error === "github" && (
          <p className="mb-3 text-sm text-destructive">
            Something went wrong finishing setup. Please try again.
          </p>
        )}
        <form action={finishOnboarding} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <select
              id="country"
              name="country"
              required
              defaultValue={defaultCountry}
              autoComplete="country"
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>
                Select your country
              </option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <SubmitButton>Continue</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
