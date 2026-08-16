import type { Metadata } from "next";
import { StackProvider, StackTheme } from "@hexclave/next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { auth } from "@/auth";
import { cn } from "@/lib/cn";
import { getStackServerApp } from "@/lib/stack";
import { env } from "@/lib/env";
import {
  setSentryUser,
  userFromSession,
} from "@/lib/observability/sentry-user";
import { BuiltBy } from "@/components/built-by";
import { RuntimeEnvScript } from "./runtime-env";
import { SentryUserClient } from "./sentry-user-client";

export const metadata: Metadata = {
  authors: [{ name: "Enno Gelhaus", url: "https://ennogelhaus.de" }],
  creator: "Enno Gelhaus",
  publisher: "Gelhaus Solutions",
  title: "Contribution Checker",
  description: "Gate PRs behind a contributor application form.",
};

// Force every route to render at request time. The app is built into a generic
// image with NO Hexclave env (STACK_*), so at build time auth() short-circuits
// to null BEFORE reading cookies -> Next would prerender auth-gated pages like
// /dashboard, /admin and /welcome as STATIC and bake their unauthenticated
// "redirect to /handler/sign-in" into the output, which is then served to every
// signed-in user (the redirect loop). Rendering dynamically makes auth() run at
// runtime with the real session. The whole app depends on the session anyway.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const user = userFromSession(session);
  // Server-side scope: attaches user to errors / spans / logs raised during
  // the rest of this request's render path.
  setSentryUser(user);

  // Only build/mount the Hexclave provider when configured, so unconfigured
  // deploys and the build phase don't require a live instance.
  const stackApp = env.stackConfigured ? await getStackServerApp() : null;

  const content = (
    <>
      <SentryUserClient user={user} />
      {children}
      <BuiltBy />
    </>
  );

  return (
    // Geist ships its woff2 inside the package rather than fetching from a CDN,
    // which is what this deployment needs: the CSP is `font-src 'self' data:`,
    // and the image is built in environments that may have no network.
    <html
      lang="en"
      className={cn(GeistSans.variable, GeistMono.variable)}
    >
      <head>
        <RuntimeEnvScript />
      </head>
      <body className="min-h-screen font-sans antialiased">
        {stackApp ? (
          <StackProvider app={stackApp}>
            <StackTheme>{content}</StackTheme>
          </StackProvider>
        ) : (
          content
        )}
      </body>
    </html>
  );
}
