import type { Metadata } from "next";
import { StackProvider, StackTheme } from "@hexclave/next";
import "./globals.css";
import { auth } from "@/auth";
import { getStackServerApp } from "@/lib/stack";
import { env } from "@/lib/env";
import {
  setSentryUser,
  userFromSession,
} from "@/lib/observability/sentry-user";
import { RuntimeEnvScript } from "./runtime-env";
import { SentryUserClient } from "./sentry-user-client";

export const metadata: Metadata = {
  title: "Contribution Checker",
  description: "Gate PRs behind a contributor application form.",
};

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
    </>
  );

  return (
    <html lang="en">
      <head>
        <RuntimeEnvScript />
      </head>
      <body className="min-h-screen antialiased">
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
