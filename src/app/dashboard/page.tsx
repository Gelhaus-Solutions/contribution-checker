import Link from "next/link";
import { FileText, FolderGit2 } from "lucide-react";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/ui/format";
import { EmptyState } from "@/components/empty-state";
import { SHELL } from "@/lib/ui/layout";
import {
  listAppliedProjectsForUser,
  listProjectsForUser,
} from "@/lib/projects";


export default async function DashboardHome() {
  const session = await auth();
  if (!session?.user)
    redirect("/handler/sign-in?after_auth_return_to=/dashboard");
  if (session.user.restricted) redirect("/restricted");
  if (!session.user.ghId) redirect("/welcome");

  const [memberships, applications] = await Promise.all([
    listProjectsForUser(session.user.id),
    listAppliedProjectsForUser(session.user.id),
  ]);

  return (
    <>
      <SiteHeader />
      <main className={`${SHELL} space-y-10 py-10`}>
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Your projects</h2>
              <p className="text-sm text-muted-foreground">
                Projects where you&apos;re owner, admin, or reviewer.
              </p>
            </div>
            {session.user.canCreateProj ? (
              <Button asChild>
                <Link href="/dashboard/projects/new">New project</Link>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask a super-admin to allowlist you to create projects.
              </p>
            )}
          </div>

          {memberships.length === 0 ? (
            <Card>
              <EmptyState
                icon={FolderGit2}
                title="No projects yet"
                description="A project links one or more repositories to an application form. Create one to start gating pull requests."
              />
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {memberships.map(({ project, role }) => (
                <Link
                  key={project.id}
                  href={`/dashboard/projects/${project.id}`}
                  className="block"
                >
                  <Card className="transition-colors hover:border-foreground/20">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">
                          {project.name}
                        </CardTitle>
                        <Badge variant="outline">{role}</Badge>
                      </div>
                      <CardDescription className="line-clamp-2">
                        {project.description || "No description."}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex gap-4 text-xs text-muted-foreground">
                      <span>{project._count.repos} repos</span>
                      <span>{project._count.applications} applications</span>
                      <span>{project._count.members} members</span>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">Your applications</h2>
          {applications.length === 0 ? (
            <Card>
              <EmptyState
                icon={FileText}
                title="No applications yet"
                description="Applications you submit to gated projects show up here with their status."
              />
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {applications.map((app) => (
                    <li
                      key={app.id}
                      className="flex items-center justify-between gap-4 px-6 py-3 text-sm"
                    >
                      <Link
                        href={`/p/${app.project.slug}`}
                        className="font-medium hover:underline"
                      >
                        {app.project.name}
                      </Link>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {formatDate(app.createdAt)}
                        </span>
                        <StatusBadge status={app.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </section>
      </main>
    </>
  );
}
