import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { env } from "@/lib/env";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function ProjectRepos({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const repos = await prisma.repo.findMany({
    where: { projectId: id },
    orderBy: { fullName: "asc" },
  });

  const installUrl = env.githubAppConfigured
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(id)}`
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked repos</CardTitle>
          <CardDescription>
            Repos where the contribution checker watches PRs. Install the GitHub
            App on a repo to link it here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!installUrl && (
            <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-warning-foreground">
              GitHub App is not configured yet. A super-admin needs to bootstrap
              it from <code>/admin/setup</code>.
            </div>
          )}
          {repos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos linked yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="font-mono">{r.fullName}</span>
                  <div className="flex items-center gap-2">
                    {!r.active && <Badge variant="destructive">uninstalled</Badge>}
                    {r.requireOwnApproval && (
                      <Badge variant="warning">per-repo approval</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {installUrl && (
            <Button asChild>
              <a href={installUrl}>Add repo via GitHub App</a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
