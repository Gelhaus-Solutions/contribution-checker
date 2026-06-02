"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getStackServerApp } from "@/lib/stack";
import { logger } from "@/lib/logger";
import {
  captureGeoCountry,
  reconcileOrgPermissions,
  syncGitHubIdentity,
} from "@/lib/auth/sync-user";

/**
 * Complete onboarding (no user input): bind the GitHub identity (ghId/ghLogin)
 * to the local row, reconcile org permissions, and capture the country code in
 * the background from Hexclave's geo signal. By the time this runs the welcome
 * client has already ensured the GitHub connection, so the connected-account
 * token is available server-side (read-only, no cookie write).
 *
 * Takes a FormData arg because it's invoked as a `<form action>` (the form has
 * no fields; it's just the submit trigger), but reads nothing from it.
 */
export async function finishOnboarding(_formData: FormData): Promise<void> {
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
    const { userId } = await syncGitHubIdentity(stackUser, session.user.id);
    // 2. Org roles (Instance Admin team membership / global permissions) mirrored
    //    to the local cache columns.
    await reconcileOrgPermissions(stackUser, userId);
    // 3. Country (background, best-effort) -> Hexclave metadata + User.country.
    await captureGeoCountry(stackUser, userId);
  } catch (e) {
    logger.error(
      { err: e, "stack.user_id": stackUser.id },
      "welcome: onboarding failed",
    );
    redirect("/welcome?error=github");
  }

  redirect("/dashboard");
}
