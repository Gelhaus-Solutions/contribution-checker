"use client";

import * as React from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchRecentNotifications } from "@/app/dashboard/notifications/actions";
import type { RecentNotification } from "@/lib/notifications/inbox";
import { formatDateTime } from "@/lib/ui/format";

/**
 * Header notification bell: unread badge + a dropdown preview of the most recent
 * notifications, with "View all" linking to the full inbox. The Inbox is no
 * longer a standalone nav link; it lives here in the user cluster. Opening the
 * dropdown does NOT mark anything read (that happens on the inbox page).
 */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = React.useState(initialUnread);
  const [items, setItems] = React.useState<RecentNotification[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onOpenChange(open: boolean) {
    if (!open) return;
    setLoading(true);
    try {
      const res = await fetchRecentNotifications();
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        aria-label="Notifications"
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 p-0">
        <DropdownMenuLabel className="px-3 py-2">Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-80 overflow-y-auto">
          {loading && items === null ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          ) : items && items.length > 0 ? (
            <ul className="divide-y divide-border">
              {items.map((n) => {
                const inner = (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{n.label}</span>
                      <time className="shrink-0 text-xs text-muted-foreground">
                        {formatDateTime(n.createdAt)}
                      </time>
                    </div>
                  </>
                );
                const cls = `block px-3 py-2 text-sm ${n.read ? "" : "bg-muted/40"}`;
                return (
                  <li key={n.id}>
                    {n.href ? (
                      <Link href={n.href} className={`${cls} hover:bg-muted/60`}>
                        {inner}
                      </Link>
                    ) : (
                      <div className={cls}>{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing here yet.
            </p>
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <Link
          href="/dashboard/notifications"
          className="block px-3 py-2 text-center text-sm font-medium text-primary hover:underline"
        >
          View all
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
