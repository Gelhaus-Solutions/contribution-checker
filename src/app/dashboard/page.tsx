import Link from "next/link";
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
import {
  listAppliedProjectsForUser,
  listProjectsForUser,
} from "@/lib/projects";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
};

export default async function DashboardHome() {
  const session = await auth();
  if (!session?.user)
    redirect("/handler/sign-in?after_auth_return_to=/dashboard");
  if (!session.user.ghId) redirect("/welcome");

  const [memberships, applications] = await Promise.all([
    listProjectsForUser(session.user.id),
    listAppliedProjectsForUser(session.user.id),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl space-y-10 px-4 py-10">
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
              <CardContent className="py-10 text-center text-muted-foreground">
                You&apos;re not a member of any project yet.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              <CardContent className="py-10 text-center text-muted-foreground">
                You haven&apos;t applied to any project yet.
              </CardContent>
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
                          {app.createdAt.toISOString().slice(0, 10)}
                        </span>
                        <Badge
                          variant={STATUS_VARIANT[app.status] ?? "secondary"}
                        >
                          {app.status}
                        </Badge>
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
