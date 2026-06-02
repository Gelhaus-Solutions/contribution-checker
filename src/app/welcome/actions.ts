"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getStackServerApp } from "@/lib/stack";
import { isValidCountryCode } from "@/lib/countries";
import { logger } from "@/lib/logger";
import {
  reconcileOrgPermissions,
  setOnboardingCountry,
  syncGitHubIdentity,
} from "@/lib/auth/sync-user";

/**
 * Complete onboarding: bind the GitHub identity (ghId/ghLogin) to the local
 * row, reconcile org permissions, and persist the country code into Hexclave +
 * the local mirror. By the time this runs the welcome client has already forced
 * the GitHub connection, so the connected-account token is available.
 */
export async function finishOnboarding(formData: FormData): Promise<void> {
  const country = String(formData.get("country") ?? "").trim();
  if (!isValidCountryCode(country)) {
    redirect("/welcome?error=country");
  }

  const session = await auth();
  if (!session?.user) {
    redirect("/handler/sign-in?after_auth_return_to=/welcome");
  }

  const stackApp = await getStackServerApp();
  const stackUser = await stackApp.getUser();
  if (!stackUser) {
    redirect("/handler/sign-in?after_auth_return_to=/welcome");
  }

  try {
    // 1. GitHub identity (also resolves the lazy-link merge); returns the local
    //    user id the session is now bound to.
    const { userId, ghLogin } = await syncGitHubIdentity(
      stackUser,
      session.user.id,
    );
    // 2. Org permissions from env CSVs (additive) + mirror to local columns.
    await reconcileOrgPermissions(stackUser, ghLogin, userId);
    // 3. Country -> Hexclave clientReadOnlyMetadata + User.country.
    await setOnboardingCountry(stackUser, userId, country);
  } catch (e) {
    logger.error(
      { err: e, "stack.user_id": stackUser.id },
      "welcome: onboarding failed",
    );
    redirect("/welcome?error=github");
  }

  redirect("/dashboard");
}
