import { prisma } from "@/lib/db";
import { requireProjectPermission } from "@/lib/authz";
import { env } from "@/lib/env";
import { getAppSlug } from "@/lib/github/app";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";
import { CodeBlock } from "@/components/code-block";
import { EmptyState } from "@/components/empty-state";
import { addRepoByName, removeRepo } from "./actions";

function ciGateYaml(baseUrl: string, slug: string): string {
  return `name: Contribution check (gate)
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize]

permissions:
  id-token: write
  pull-requests: write
  issues: write
  checks: write
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      CC_BASE: ${baseUrl}
      CC_PROJECT: ${slug}
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const audience = \`\${process.env.CC_BASE}/p/\${process.env.CC_PROJECT}\`;
            const jwt = await core.getIDToken(audience);
            const pr = context.payload.pull_request;

            // Fetch PR context for quality scoring (skipped server-side if
            // the project hasn't enabled quality). Capped at 100 files+commits
            // each to keep the body reasonable.
            const [filesRes, commitsRes, userRes] = await Promise.all([
              github.rest.pulls.listFiles({ ...context.repo, pull_number: pr.number, per_page: 100 }).catch(() => null),
              github.rest.pulls.listCommits({ ...context.repo, pull_number: pr.number, per_page: 100 }).catch(() => null),
              github.rest.users.getByUsername({ username: pr.user.login }).catch(() => null),
            ]);
            const qualityContext = {
              files: (filesRes?.data ?? []).map(f => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch ?? null,
                previous_filename: f.previous_filename,
              })),
              filesTruncated: (filesRes?.data ?? []).length >= 100,
              commits: (commitsRes?.data ?? []).map(c => ({
                sha: c.sha,
                message: c.commit?.message ?? "",
                authorLogin: c.author?.login,
                authorEmail: c.commit?.author?.email,
                committerEmail: c.commit?.committer?.email,
              })),
              account: userRes ? {
                login: userRes.data.login,
                createdAt: userRes.data.created_at,
                publicRepos: userRes.data.public_repos,
                followers: userRes.data.followers,
                bio: userRes.data.bio,
                email: userRes.data.email,
                hasAvatar: !!userRes.data.avatar_url,
              } : { login: pr.user.login },
            };

            const r = await fetch(\`\${process.env.CC_BASE}/api/ci/check-pr\`, {
              method: "POST",
              headers: { authorization: \`Bearer \${jwt}\`, "content-type": "application/json" },
              body: JSON.stringify({
                projectSlug: process.env.CC_PROJECT,
                action: context.payload.action,
                pull_request: {
                  number: pr.number,
                  node_id: pr.node_id,
                  title: pr.title,
                  body: pr.body,
                  head: { sha: pr.head.sha },
                  user: { login: pr.user.login, id: pr.user.id, type: pr.user.type },
                },
                qualityContext,
              }),
            });
            if (!r.ok) { core.setFailed(\`check-pr \${r.status}\`); return; }
            const d = await r.json();

            // Publish the Check Run on the PR head SHA, if the server returned a payload.
            if (d.check && pr.head?.sha) {
              await github.rest.checks.create({
                ...context.repo,
                head_sha: pr.head.sha,
                name: d.check.name,
                status: d.check.status,
                conclusion: d.check.conclusion,
                details_url: d.check.detailsUrl,
                output: { title: d.check.title, summary: d.check.summary },
              }).catch(e => core.warning(\`check-run publish: \${e.message}\`));
            }

            if (d.decision === "block" && d.closePr) {
              await github.rest.pulls.update({ ...context.repo, pull_number: pr.number, state: "closed" });
              if (d.body) await github.rest.issues.createComment({
                ...context.repo, issue_number: pr.number, body: d.body });
            }
            if (d.labels) {
              for (const l of d.labels.remove ?? [])
                await github.rest.issues.removeLabel({ ...context.repo, issue_number: pr.number, name: l }).catch(() => {});
              if (d.labels.add?.length)
                await github.rest.issues.addLabels({ ...context.repo, issue_number: pr.number, labels: d.labels.add });
            }
`;
}

function ciReconcileYaml(baseUrl: string, slug: string): string {
  return `name: Contribution check (reconcile)
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

permissions:
  id-token: write
  pull-requests: write
  issues: write

jobs:
  reconcile:
    runs-on: ubuntu-latest
    env:
      CC_BASE: ${baseUrl}
      CC_PROJECT: ${slug}
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const audience = \`\${process.env.CC_BASE}/p/\${process.env.CC_PROJECT}\`;
            const jwt = async () => core.getIDToken(audience);
            const list = await fetch(\`\${process.env.CC_BASE}/api/ci/reconcile\`, {
              method: "POST",
              headers: { authorization: \`Bearer \${await jwt()}\`, "content-type": "application/json" },
              body: JSON.stringify({ projectSlug: process.env.CC_PROJECT }),
            }).then(r => r.json());
            const confirmed = [];
            for (const it of list.reopens ?? []) {
              try {
                await github.rest.pulls.update({ ...context.repo, pull_number: it.prNumber, state: "open" });
                if (it.body) await github.rest.issues.createComment({
                  ...context.repo, issue_number: it.prNumber, body: it.body });
                if (it.labels) {
                  for (const l of it.labels.remove ?? [])
                    await github.rest.issues.removeLabel({ ...context.repo, issue_number: it.prNumber, name: l }).catch(() => {});
                  if (it.labels.add?.length)
                    await github.rest.issues.addLabels({ ...context.repo, issue_number: it.prNumber, labels: it.labels.add });
                }
                confirmed.push({ prCheckId: it.prCheckId, newStatus: "APPROVED" });
              } catch (e) { core.warning(\`reopen \${it.prNumber}: \${e.message}\`); }
            }
            if (confirmed.length) {
              await fetch(\`\${process.env.CC_BASE}/api/ci/reconcile/confirm\`, {
                method: "POST",
                headers: { authorization: \`Bearer \${await jwt()}\`, "content-type": "application/json" },
                body: JSON.stringify({ projectSlug: process.env.CC_PROJECT, confirmed }),
              });
            }
`;
}

export default async function ProjectRepos({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const { q } = parsePageParams(await searchParams);
  await requireProjectPermission(id, "project_repos_manage");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { slug: true, name: true },
  });
  if (!project) notFound();

  const repos = await prisma.repo.findMany({
    where: {
      projectId: id,
      ...(q ? { fullName: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { fullName: "asc" },
  });

  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const installUrl = env.githubAppConfigured
    ? `https://github.com/apps/${await getAppSlug()}/installations/new?state=${encodeURIComponent(id)}`
    : null;
  const gateYaml = ciGateYaml(baseUrl, project.slug);
  const reconcileYaml = ciReconcileYaml(baseUrl, project.slug);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a repo</CardTitle>
          <CardDescription>
            Enter any GitHub repo by name. PR gating starts once either the
            GitHub App is installed on it, or you set up the GitHub Actions
            workflow below.
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
            <SubmitButton>Add</SubmitButton>
          </form>
          {installUrl && (
            <div className="text-xs text-muted-foreground">
              Already added the repo here?{" "}
              <a className="underline" href={installUrl}>
                Install the GitHub App
              </a>{" "}
              to activate PR checks, or use the GitHub Actions workflow below.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked repos</CardTitle>
          <CardDescription>
            Repos tracked by this project. Each must be activated either by
            installing the GitHub App or by the Actions workflow.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SearchInput
            pathname={`/dashboard/projects/${id}/repos`}
            q={q}
            placeholder="Search repos"
          />
          {repos.length === 0 ? (
            <EmptyState
              variant="row"
              query={q}
              title="No repositories linked"
              description="Add a repository above to start gating its pull requests."
            />
          ) : (
            <ul className="divide-y divide-border">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="font-mono">{r.fullName}</span>
                  <div className="flex items-center gap-2">
                    {r.installationId != null && r.active && (
                      <Badge variant="success">App installed</Badge>
                    )}
                    {r.installationId == null && r.active && (
                      <Badge variant="secondary">CI mode</Badge>
                    )}
                    {r.installationId != null && !r.active && (
                      <Badge variant="destructive">uninstalled</Badge>
                    )}
                    {r.requireOwnApproval && (
                      <Badge variant="warning">per-repo approval</Badge>
                    )}
                    <form action={removeRepo}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="repoId" value={r.id} />
                      <SubmitButton
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                      >
                        Remove
                      </SubmitButton>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            GitHub Actions CI (no App)
          </CardTitle>
          <CardDescription>
            For repos where you can&apos;t install the GitHub App. Drop these
            two workflows into <code>.github/workflows/</code>; they
            authenticate via the GitHub Actions OIDC token, with no secrets to
            configure.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Add the repo above using its <code>owner/name</code>.</li>
            <li>
              Save <code>contribution-check-gate.yml</code> and{" "}
              <code>contribution-check-reconcile.yml</code> below into{" "}
              <code>.github/workflows/</code> on the default branch.
            </li>
            <li>Push. PR gating activates on the next opened PR.</li>
          </ol>

          <CodeBlock
            filename=".github/workflows/contribution-check-gate.yml"
            code={gateYaml}
          />

          <CodeBlock
            filename=".github/workflows/contribution-check-reconcile.yml"
            code={reconcileYaml}
          />

          <p className="text-xs text-muted-foreground">
            Reopen-on-approval has up to ~10 minutes of latency (matches the
            reconcile cron). Auto-bypass for repository collaborators is not
            available in CI mode. List collaborators in the project&apos;s
            bypass handles instead.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
