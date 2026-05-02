import Link from "next/link";
import { requireSession } from "@/lib/authz";
import { listNotifications } from "@/lib/notifications/inbox";
import { SiteHeader } from "@/components/site-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { markAllReadAction } from "./actions";

const KIND_LABELS: Record<string, string> = {
  "application.submitted": "New application",
  "application.approved": "Application approved",
  "application.denied": "Application denied",
  "application.revoked": "Approval revoked",
  "application.note_added": "Note added",
  "project.invited": "Invited to a project",
  "pr.blocked": "PR blocked",
};

export default async function NotificationsPage() {
  const session = await requireSession();
  const items = await listNotifications(session.user.id, 100);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <form action={markAllReadAction}>
            <Button type="submit" size="sm" variant="outline">
              Mark all read
            </Button>
          </form>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inbox</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {items.length === 0 ? (
              <div className="px-6 pb-6 text-sm text-muted-foreground">
                Nothing here yet.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => {
                  const payload = (() => {
                    try {
                      return JSON.parse(n.payload) as Record<string, unknown>;
                    } catch {
                      return {} as Record<string, unknown>;
                    }
                  })();
                  const projectId =
                    typeof payload.projectId === "string"
                      ? payload.projectId
                      : null;
                  const projectSlug =
                    typeof payload.projectSlug === "string"
                      ? payload.projectSlug
                      : null;
                  const projectName =
                    typeof payload.projectName === "string"
                      ? payload.projectName
                      : null;
                  const applicationId =
                    typeof payload.applicationId === "string"
                      ? payload.applicationId
                      : null;
                  const ghLogin =
                    typeof payload.ghLogin === "string" ? payload.ghLogin : null;
                  const reason =
                    typeof payload.reason === "string" ? payload.reason : null;

                  // Reviewer-side notifications go to the application detail
                  // page; applicant-side go to the public apply page.
                  const href =
                    n.kind === "application.submitted" &&
                    projectId &&
                    applicationId
                      ? `/dashboard/projects/${projectId}/applications/${applicationId}`
                      : n.kind === "project.invited" && projectId
                        ? `/dashboard/projects/${projectId}`
                        : projectSlug
                          ? `/p/${projectSlug}`
                          : null;

                  const body = (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="font-medium">
                          {KIND_LABELS[n.kind] ?? n.kind}
                        </div>
                        <time className="text-xs text-muted-foreground">
                          {n.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                        </time>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {projectName && (
                          <span>
                            {projectName}
                            {ghLogin ? ` · @${ghLogin}` : ""}
                          </span>
                        )}
                        {reason && (
                          <div className="mt-1">Reason: {reason}</div>
                        )}
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
          </CardContent>
        </Card>
      </main>
    </>
  );
}

