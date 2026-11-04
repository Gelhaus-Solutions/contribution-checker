"use client";

import Link from "next/link";
import {
  HeaderChrome,
  type HeaderChromePerson,
} from "@/components/header-chrome";
import { NotificationBell } from "@/components/notification-bell";
import { Button } from "@/components/ui/button";

/**
 * Right-hand header cluster: the notification bell and GPlatform Identity's
 * apps picker and account popup (`HeaderChrome`), which carry the data export,
 * session recording, Admin for super-admins, and sign-out. On a server where
 * GPID's header controls are not set up (no GPID_CHROME_TOKEN), the bell, an
 * Admin link for super-admins and a sign-out button stand in. Rendered only
 * when GPID is configured; otherwise there is nobody signed in to show.
 */
export function UserCluster({
  isSuperAdmin,
  unread,
  gpidConfigured,
  identityChrome = false,
  person,
}: {
  isSuperAdmin: boolean;
  unread: number;
  gpidConfigured: boolean;
  /** GPlatform Identity's controls are set up on this server. */
  identityChrome?: boolean;
  person: HeaderChromePerson;
}) {
  if (!gpidConfigured) return null;

  if (identityChrome) {
    return (
      <div className="flex items-center gap-2">
        <NotificationBell initialUnread={unread} />
        <HeaderChrome person={person} isSuperAdmin={isSuperAdmin} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <NotificationBell initialUnread={unread} />
      {isSuperAdmin ? (
        <Button asChild size="sm" variant="ghost">
          <Link href="/admin">Admin</Link>
        </Button>
      ) : null}
      <form action="/auth/sign-out" method="post">
        <Button type="submit" size="sm" variant="outline">
          Sign out
        </Button>
      </form>
    </div>
  );
}
