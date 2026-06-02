"use client";

import { useRouter } from "next/navigation";
import { Shield } from "lucide-react";
import { UserButton } from "@hexclave/next";
import { NotificationBell } from "@/components/notification-bell";

/**
 * Right-hand header cluster: the notification bell + Hexclave's UserButton.
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
}: {
  isSuperAdmin: boolean;
  unread: number;
  stackConfigured: boolean;
}) {
  const router = useRouter();
  if (!stackConfigured) return null;

  const extraItems = isSuperAdmin
    ? [
        {
          text: "Admin",
          icon: <Shield className="h-4 w-4" />,
          onClick: () => router.push("/admin"),
        },
      ]
    : [];

  return (
    <div className="flex items-center gap-2">
      <NotificationBell initialUnread={unread} />
      <UserButton showUserInfo extraItems={extraItems} />
    </div>
  );
}
