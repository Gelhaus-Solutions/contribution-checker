import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { StackHandler } from "@hexclave/next";
import { SiteHeader } from "@/components/site-header";
import { getStackServerApp } from "@/lib/stack";
import { SHELL } from "@/lib/ui/layout";
import { signInClosed } from "@/lib/lockdown";

/**
 * Hexclave (Stack Auth) catch-all handler: renders sign-in, sign-up,
 * OAuth callback, account settings, email verification, etc.
 *
 * In-app, logged-in pages (account settings) render EMBEDDED in the app shell
 * (SiteHeader + container) with `fullPage={false}`, so there's normal app chrome
 * and a way back. Auth-entry screens (sign-in/up, callbacks, verification) stay
 * full-page. Wrapped in <Suspense> because StackHandler's pages use client hooks
 * (useUser) that bail to client-side rendering via suspendIfSsr().
 */
const EMBEDDED_ROUTES = new Set(["account-settings"]);

export default async function Handler(props: {
  params: Promise<{ stack?: string[] }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { stack } = await props.params;
  // GLockdown's kill switch at `full` and from AAL phase 1
  // (src/lib/lockdown.ts): nobody signs in or up, and the lockdown page says
  // so; signing out still works.
  if (signInClosed() && stack?.[0] !== "sign-out") redirect("/lockdown");
  const app = await getStackServerApp();
  const embedded = EMBEDDED_ROUTES.has(stack?.[0] ?? "");

  if (embedded) {
    return (
      <>
        <SiteHeader />
        <main className={`${SHELL} py-6`}>
          <Link
            href="/dashboard"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Back to dashboard
          </Link>
          <div className="mt-4">
            <Suspense>
              <StackHandler fullPage={false} app={app} routeProps={props} />
            </Suspense>
          </div>
        </main>
      </>
    );
  }

  return (
    <Suspense>
      <StackHandler fullPage app={app} routeProps={props} />
    </Suspense>
  );
}
