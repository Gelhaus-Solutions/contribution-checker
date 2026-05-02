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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addRepoByName, removeRepo } from "./actions";

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
          <CardTitle className="text-base">Add a repo</CardTitle>
          <CardDescription>
            Enter any GitHub repo by name. PR gating only kicks in once the
            GitHub App is installed on it, but you can list repos here ahead of
            time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            action={addRepoByName}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="projectId" value={id} />
            <div className="flex-1 space-y-2">
              <Label htmlFor="fullName">Repository</Label>
              <Input
                id="fullName"
                name="fullName"
                placeholder="owner/repo"
                pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+"
                required
              />
            </div>
            <Button type="submit">Add</Button>
          </form>
          {installUrl && (
            <div className="text-xs text-muted-foreground">
              Already added the repo here?{" "}
              <a className="underline" href={installUrl}>
                Install the GitHub App
              </a>{" "}
              to activate PR checks.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked repos</CardTitle>
          <CardDescription>
            Repos tracked by this project. The GitHub App must be installed for
            the contribution checker to act on PRs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {repos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="font-mono">{r.fullName}</span>
                  <div className="flex items-center gap-2">
                    {!r.installationId && (
                      <Badge variant="warning">App not installed</Badge>
                    )}
                    {r.installationId && !r.active && (
                      <Badge variant="destructive">uninstalled</Badge>
                    )}
                    {r.requireOwnApproval && (
                      <Badge variant="warning">per-repo approval</Badge>
                    )}
                    <form action={removeRepo}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="repoId" value={r.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                      >
                        Remove
                      </Button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {installUrl && (
            <Button asChild variant="outline">
              <a href={installUrl}>Install GitHub App on more repos</a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
