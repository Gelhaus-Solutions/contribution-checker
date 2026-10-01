"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import type { SentryUser } from "@/lib/observability/sentry-user";

export function SentryUserClient({ user }: { user: SentryUser | null }) {
  useEffect(() => {
    if (!user) {
      Sentry.setUser(null);
      return;
    }
    // Internal id only: email and GitHub login stay out of Sentry.
    Sentry.setUser({ id: user.id });
  }, [user]);
  return null;
}
