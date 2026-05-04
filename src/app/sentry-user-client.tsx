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
    Sentry.setUser({
      id: user.id,
      username: user.ghLogin ?? undefined,
      email: user.email ?? undefined,
    });
  }, [user]);
  return null;
}
