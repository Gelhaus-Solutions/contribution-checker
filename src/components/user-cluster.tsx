"use client";

import { useRouter } from "next/navigation";
import { Download, Shield, Video } from "lucide-react";
import { UserButton } from "@hexclave/next";
import {
  HeaderChrome,
  type HeaderChromePerson,
} from "@/components/header-chrome";
import { NotificationBell } from "@/components/notification-bell";
import { reopenReplayChoice } from "@/lib/observability/replay-consent";

/**
 * Right-hand header cluster: the notification bell + Hexclave's UserButton, or
 * GPlatform Identity's apps picker and account popup where the server has them
 * set up (`HeaderChrome`), which carry the same items.
 * UserButton provides the avatar dropdown with account settings (Hexclave's
 * built-in /handler account page) and sign-out. The Admin link is pushed as an
 * extra item for super-admins only (extraItems use onClick, so we navigate via
 * the router). Rendered only when Hexclave is configured (StackProvider is then
 * mounted in the root layout); otherwise we show nothing here.
 */
export function UserCluster({
  isSuperAdmin,
  unread,
  stackConfigured,
  identityChrome = false,
  person,
}: {
  isSuperAdmin: boolean;
  unread: number;
  stackConfigured: boolean;
  /** GPlatform Identity's controls are set up on this server. */
  identityChrome?: boolean;
  person: HeaderChromePerson;
}) {
  const router = useRouter();
  if (!stackConfigured) return null;

  if (identityChrome) {
    return (
      <div className="flex items-center gap-2">
        <NotificationBell initialUnread={unread} />
        <HeaderChrome person={person} isSuperAdmin={isSuperAdmin} />
      </div>
    );
  }

  // Self-service data export (GDPR Art. 15 and 20). A plain navigation: the
  // route answers with Content-Disposition: attachment, so the browser
  // downloads the file and stays on the page.
  const extraItems = [
    {
      text: "Download my data",
      icon: <Download className="h-4 w-4" />,
      onClick: () => {
        window.location.assign("/api/account/export");
      },
    },
    // Where a yes or no to session recording is changed (see ReplayConsent).
    {
      text: "Session recording",
      icon: <Video className="h-4 w-4" />,
      onClick: reopenReplayChoice,
    },
    ...(isSuperAdmin
      ? [
          {
            text: "Admin",
            icon: <Shield className="h-4 w-4" />,
            onClick: () => router.push("/admin"),
          },
        ]
      : []),
  ];

  return (
    <div className="flex items-center gap-2">
      <NotificationBell initialUnread={unread} />
      <UserButton showUserInfo extraItems={extraItems} />
    </div>
  );
}
