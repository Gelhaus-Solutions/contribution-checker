import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SHELL_NARROW } from "@/lib/ui/layout";
import { createProjectAction } from "./actions";
import { CreateProjectForm } from "./form";

export default async function NewProject() {
  const session = await auth();
  if (!session?.user)
    redirect("/handler/sign-in?after_auth_return_to=/dashboard/projects/new");
  if (session.user.restricted) redirect("/restricted");
  if (!session.user.ghId) redirect("/welcome");
  if (!session.user.canCreateProj) redirect("/dashboard");

  return (
    <>
      <SiteHeader />
      <main className={`${SHELL_NARROW} py-10`}>
        <Card>
          <CardHeader>
            <CardTitle>Create project</CardTitle>
            <CardDescription>
              A project groups one or more GitHub repositories under a single
              application. You can link repos and customize the form after.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateProjectForm action={createProjectAction} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
