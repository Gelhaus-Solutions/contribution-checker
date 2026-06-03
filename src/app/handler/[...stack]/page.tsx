import { Suspense } from "react";
import { StackHandler } from "@hexclave/next";
import { getStackServerApp } from "@/lib/stack";

/**
 * Hexclave (Stack Auth) catch-all handler: renders sign-in, sign-up,
 * OAuth callback, account settings, email verification, etc. Replaces the old
 * `/api/auth/[...nextauth]` route.
 *
 * Wrapped in <Suspense> because StackHandler's pages use client hooks
 * (useUser/useTokenStore) that call suspendIfSsr() and bail to client-side
 * rendering; without a boundary Next throws NoSuspenseBoundaryError (500),
 * which surfaces e.g. on the account-settings page linked from the UserButton.
 */
export default async function Handler(props: {
  params: Promise<{ stack?: string[] }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const app = await getStackServerApp();
  return (
    <Suspense>
      <StackHandler fullPage app={app} routeProps={props} />
    </Suspense>
  );
}
