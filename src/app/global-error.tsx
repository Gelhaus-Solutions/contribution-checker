"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

// Heuristic: the in-flight stale-Server-Action crash. Next.js logs this two
// ways depending on which branch took it. Sometimes the message is "Failed
// to find Server Action ...", sometimes it's the raw "Cannot read properties
// of undefined (reading 'workers')" coming out of action-utils.js. Treat
// both as the same recoverable condition: the user's tab is older than the
// current deployment's action manifest, so a full reload re-fetches a fresh
// manifest with current IDs.
function isStaleServerActionError(error: Error & { digest?: string }): boolean {
  const msg = (error?.message ?? "").toLowerCase();
  if (msg.includes("failed to find server action")) return true;
  if (msg.includes("reading 'workers'")) return true;
  if (msg.includes('reading "workers"')) return true;
  return false;
}

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    const stale = isStaleServerActionError(error);
    Sentry.captureException(error, {
      tags: {
        "error.boundary": "global",
        "error.stale_server_action": String(stale),
      },
      extra: { digest: error.digest },
    });
    Sentry.metrics.count("app.client_error", 1, {
      attributes: {
        "error.type": error.name ?? "Error",
        "error.stale_server_action": String(stale),
      },
    });

    // For a stale-action crash, the manifest mismatch is permanent for this
    // tab, so a soft refresh is the only way out. Wait a tick so Sentry's
    // beacon has a chance to fire.
    if (stale && typeof window !== "undefined") {
      const id = window.setTimeout(() => {
        window.location.reload();
      }, 1200);
      return () => window.clearTimeout(id);
    }
  }, [error]);

  // This boundary replaces the root layout, so it has to render its own <html>
  // and pull in the stylesheet itself. It also cannot use the theme cookie
  // (the layout that reads it is exactly what failed), so it renders in the
  // light palette rather than risking an unstyled page.
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
          <p className="font-mono text-xs tracking-widest text-muted-foreground">
            {isStaleServerActionError(error) ? "reloading" : "error"}
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            {isStaleServerActionError(error)
              ? "This tab is out of date"
              : "Something went wrong"}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {isStaleServerActionError(error)
              ? "A new version was deployed while this page was open. Reloading now."
              : "The application failed to start rendering. The error has been reported."}
          </p>
          {!isStaleServerActionError(error) && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex h-8 items-center justify-center rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload
            </button>
          )}
        </main>
      </body>
    </html>
  );
}
