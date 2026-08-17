import Link from "next/link";
import { requireSession } from "@/lib/authz";
import {
  KIND_LABELS,
  listNotifications,
  notificationHref,
  parseNotificationPayload,
} from "@/lib/notifications/inbox";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination } from "@/components/ui/pagination";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";
import { formatDateTime } from "@/lib/ui/format";
import { PageHeader } from "@/components/page-header";
import { markAllReadAction } from "./actions";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamRecord>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const { page, perPage, skip, take, q } = parsePageParams(sp);
  const { items, total } = await listNotifications(session.user.id, {
    skip,
    take,
    q,
  });

  const basePath = "/dashboard/notifications";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-10">
        <PageHeader
          title="Notifications"
          back={{ href: "/dashboard", label: "Dashboard" }}
          actions={
            <form action={markAllReadAction}>
              <SubmitButton size="sm" variant="outline">
                Mark all read
              </SubmitButton>
            </form>
          }
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inbox</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="border-b border-border px-6 py-3">
              <SearchInput
                pathname={basePath}
                q={q}
                placeholder="Search by kind"
              />
            </div>
            {items.length === 0 ? (
              <div className="px-6 py-6 text-sm text-muted-foreground">
                {q
                  ? "No notifications match your search."
                  : "Nothing here yet."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => {
                  const payload = parseNotificationPayload(n.payload);
                  const projectName =
                    typeof payload.projectName === "string"
                      ? payload.projectName
                      : null;
                  const ghLogin =
                    typeof payload.ghLogin === "string"
                      ? payload.ghLogin
                      : null;
                  const reason =
                    typeof payload.reason === "string" ? payload.reason : null;

                  const href = notificationHref(n.kind, payload);

                  const body = (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="font-medium">
                          {KIND_LABELS[n.kind] ?? n.kind}
                        </div>
                        <time className="text-xs text-muted-foreground">
                          {formatDateTime(n.createdAt)}
                        </time>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {projectName && (
                          <span>
                            {projectName}
                            {ghLogin ? ` · @${ghLogin}` : ""}
                          </span>
                        )}
                        {reason && <div className="mt-1">Reason: {reason}</div>}
                      </div>
                    </>
                  );

                  const baseClass = n.readAt
                    ? "block px-6 py-3 text-sm"
                    : "block bg-muted/30 px-6 py-3 text-sm";

                  return (
                    <li key={n.id}>
                      {href ? (
                        <Link
                          href={href}
                          className={`${baseClass} transition-colors hover:bg-muted/60`}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className={baseClass}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination
              pathname={basePath}
              searchParams={sp}
              page={page}
              perPage={perPage}
              total={total}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
