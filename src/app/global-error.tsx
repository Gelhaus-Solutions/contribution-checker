"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

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

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
