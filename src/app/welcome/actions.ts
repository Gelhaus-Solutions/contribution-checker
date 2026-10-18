"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { signInPath } from "@/lib/authz";
import { getStackServerApp } from "@/lib/stack";
import { logger } from "@/lib/logger";
import { safeNextPath } from "@/lib/auth/next-path";
import {
  reconcileOrgPermissions,
  syncGitHubIdentity,
} from "@/lib/auth/sync-user";

/**
 * Complete onboarding (no user input): bind the GitHub identity (ghId/ghLogin)
 * to the local row, reconcile org permissions, and capture the country code in
 * the background from Hexclave's geo signal. By the time this runs the welcome
 * client has already ensured the GitHub provider is LINKED. It does not ensure
 * a connected-account access token, and this must not need one: Hexclave issues
 * no token when its GitHub provider runs on shared OAuth keys, which is why
 * syncGitHubIdentity reads the numeric id off the provider link instead.
 *
 * Invoked as a `<form action>`; its one field is `next`, where to go once
 * done (the project the person was applying to), a path on this site only.
 */
export async function finishOnboarding(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const again = next === null ? "/welcome" : `/welcome?next=${encodeURIComponent(next)}`;
  const session = await auth();
  if (!session?.user) redirect(await signInPath(again));
  if (session.user.restricted) redirect("/restricted");

  const stackApp = await getStackServerApp();
  const stackUser = await stackApp.getUser();
  if (!stackUser) {
    redirect(`/handler/sign-in?after_auth_return_to=${encodeURIComponent(again)}`);
  }

  try {
    // 1. GitHub identity (also resolves the lazy-link merge); returns the local
    //    user id the session is now bound to.
    const { userId } = await syncGitHubIdentity(stackUser, session.user.id);
    // 2. Org roles (Instance Admin team membership / global permissions) mirrored
    //    to the local cache columns.
    await reconcileOrgPermissions(stackUser, userId);
    // Country is no longer captured: nothing used it, and collecting it
    // without a purpose is not data minimisation (GDPR Art. 5(1)(c)).
  } catch (e) {
    logger.error(
      { err: e, "stack.user_id": stackUser.id },
      "welcome: onboarding failed",
    );
    redirect(`${again}${again.includes("?") ? "&" : "?"}error=github`);
  }

  redirect(next ?? "/dashboard");
}
