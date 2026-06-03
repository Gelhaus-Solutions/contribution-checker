import { Suspense } from "react";
import Link from "next/link";
import { StackHandler } from "@hexclave/next";
import { SiteHeader } from "@/components/site-header";
import { getStackServerApp } from "@/lib/stack";

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
  const app = await getStackServerApp();
  const { stack } = await props.params;
  const embedded = EMBEDDED_ROUTES.has(stack?.[0] ?? "");

  if (embedded) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto max-w-6xl px-4 py-6">
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
