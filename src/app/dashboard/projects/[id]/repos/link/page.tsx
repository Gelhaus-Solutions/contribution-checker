import { redirect } from "next/navigation";
import { requireProjectRole } from "@/lib/authz";
import { getInstallationOctokit } from "@/lib/github/app";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { linkRepos } from "./actions";

export default async function LinkRepos({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ installation_id?: string }>;
}) {
  const { id } = await params;
  const { installation_id } = await searchParams;
  await requireProjectRole(id, "ADMIN");

  if (!installation_id) {
    redirect(`/dashboard/projects/${id}/repos`);
  }
  if (!env.githubAppConfigured) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          GitHub App is not configured.
        </CardContent>
      </Card>
    );
  }

  const installationId = Number(installation_id);
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.request(
    "GET /installation/repositories",
    { per_page: 100 }
  );

  const existing = await prisma.repo.findMany({
    where: { projectId: id },
    select: { ghRepoId: true },
  });
  const existingIds = new Set(existing.map((r) => r.ghRepoId));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link repositories</CardTitle>
        <CardDescription>
          Select the repos you&apos;ve granted the App access to that you want
          gated by this project&apos;s application.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={linkRepos} className="space-y-3">
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="installationId" value={installationId} />
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.repositories.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                The App isn&apos;t installed on any repositories. Install it on
                a repo first via GitHub.
              </li>
            )}
            {data.repositories.map((r) => {
              const already = existingIds.has(r.id);
              return (
                <li
                  key={r.id}
                  className="flex items-center gap-3 px-4 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    name="ghRepoIds"
                    value={`${r.id}|${r.full_name}`}
                    defaultChecked={already}
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="font-mono">{r.full_name}</span>
                  {already && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      already linked
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <SubmitButton>Save selection</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
