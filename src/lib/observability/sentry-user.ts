import * as Sentry from "@sentry/nextjs";
import type { Session } from "@/lib/auth-types";

export type SentryUser = {
  id: string;
  ghLogin: string | null;
  email: string | null;
};

export function userFromSession(session: Session | null): SentryUser | null {
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    ghLogin: session.user.ghLogin ?? null,
    email: session.user.email ?? null,
  };
}

export function setSentryUser(user: SentryUser | null): void {
  if (!user) {
    Sentry.setUser(null);
    return;
  }
  Sentry.setUser({
    id: user.id,
    username: user.ghLogin ?? undefined,
    email: user.email ?? undefined,
  });
}
