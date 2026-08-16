import type { Metadata } from "next";
import { cookies } from "next/headers";
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
import { RuntimeEnvScript } from "./runtime-env";
import { SentryUserClient } from "./sentry-user-client";
import { ThemeScript, THEME_COOKIE } from "./theme-script";

const DESCRIPTION =
  "Self-hosted GitHub App that gates pull requests behind a contributor application form.";

/**
 * Generated rather than exported as a constant, on purpose. PUBLIC_BASE_URL
 * falls back to http://localhost:3000 and the image is built generic with no
 * runtime env, so a statically evaluated metadataBase would bake localhost
 * into every absolute Open Graph URL in every deployment. The root layout is
 * already force-dynamic, so evaluating this per request costs nothing.
 */
export async function generateMetadata(): Promise<Metadata> {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    metadataBase: new URL(base),
    title: {
      default: "contribution-checker",
      template: "%s · contribution-checker",
    },
    description: DESCRIPTION,
    applicationName: "contribution-checker",
    authors: [{ name: "Enno Gelhaus", url: "https://ennogelhaus.de" }],
    creator: "Enno Gelhaus",
    publisher: "Gelhaus Solutions",
    openGraph: {
      type: "website",
      siteName: "contribution-checker",
      url: base,
      title: "contribution-checker",
      description: DESCRIPTION,
    },
    twitter: { card: "summary_large_image" },
  };
}

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

  // Free: the app is already force-dynamic, so reading a cookie costs nothing
  // and it keeps the theme server-readable. Stamping "dark" here is what makes
  // a pinned dark theme flash-free; "system" is resolved by ThemeScript before
  // paint, which is why <html> needs suppressHydrationWarning.
  const theme = (await cookies()).get(THEME_COOKIE)?.value;

  const content = (
    <>
      <SentryUserClient user={user} />
      {children}
    </>
  );

  return (
    // Geist ships its woff2 inside the package rather than fetching from a CDN,
    // which is what this deployment needs: the CSP is `font-src 'self' data:`,
    // and the image is built in environments that may have no network.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        GeistSans.variable,
        GeistMono.variable,
        theme === "dark" && "dark",
      )}
    >
      <head>
        <ThemeScript />
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
