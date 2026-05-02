import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { createProjectAction } from "./actions";
import { CreateProjectForm } from "./form";

export default async function NewProject() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin?callbackUrl=/dashboard/projects/new");
  if (!session.user.canCreateProj) redirect("/dashboard");

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-4 py-10">
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
