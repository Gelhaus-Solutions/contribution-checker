import type { Metadata } from "next";
import "./globals.css";
import { auth } from "@/auth";
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

  return (
    <html lang="en">
      <head>
        <RuntimeEnvScript />
      </head>
      <body className="min-h-screen antialiased">
        <SentryUserClient user={user} />
        {children}
      </body>
    </html>
  );
}
