"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

/**
 * Route-level error boundary. Catches render errors below the root layout,
 * which is most of the app; global-error.tsx only takes over when the layout
 * itself fails.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { "error.boundary": "route" },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <StatusPage
      code={error.digest ? `error ${error.digest}` : "error"}
      title="Something went wrong"
      description="The page failed to render. The error has been reported. Trying again often works, because most failures here are transient."
    >
      <Button size="sm" onClick={reset}>
        Try again
      </Button>
    </StatusPage>
  );
}
