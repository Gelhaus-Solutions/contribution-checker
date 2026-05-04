import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  updateProjectSettings,
  addProjectWebhook,
  updateProjectWebhook,
  deleteProjectWebhook,
  sendTestWebhook,
  updateLabelSettings,
  updateBypassSettings,
  updateGatingSettings,
} from "./actions";

export default async function ProjectSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return null;

  const [recentDeliveries, webhookEndpoints] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.projectWebhook.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const bypassHandles = (() => {
    try {
      const v = JSON.parse(project.bypassHandles);
      return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
    } catch {
      return [];
    }
  })();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
          <CardDescription>Name, description, slug, and denial cooldown.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateProjectSettings} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={project.name} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" name="slug" defaultValue={project.slug} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={project.description ?? ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cooldownDays">Default cooldown after denial (days)</Label>
              <Input
                id="cooldownDays"
                name="cooldownDays"
                type="number"
                min={0}
                defaultValue={project.cooldownDays ?? ""}
                placeholder="(blank = instant resubmit when allowed)"
              />
              <p className="text-xs text-muted-foreground">
                Applied when an admin denies an application with &quot;Allow resubmitting&quot; checked.
                Leave blank to let approved-resubmits happen immediately.
                Whether resubmitting is allowed at all is a per-denial choice in the deny dialog.
              </p>
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team</CardTitle>
          <CardDescription>Manage owner, admins, and reviewers.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href={`/dashboard/projects/${id}/settings/team`}>Manage team →</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gating</CardTitle>
          <CardDescription>
            Temporarily disable the contribution checker (PRs auto-approve, no
            close/comment), or turn off GitHub status checks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateGatingSettings} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="checkerEnabled"
                value="1"
                defaultChecked={project.checkerEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Checker enabled</span>
                <span className="block text-xs text-muted-foreground">
                  When off, every PR is treated as approved &mdash; the
                  &quot;approved&quot; label is applied and PRs are not closed.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 pl-7 text-sm">
              <input
                type="checkbox"
                name="trackWhenDisabled"
                value="1"
                defaultChecked={project.trackWhenDisabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Still track PRs while disabled
                </span>
                <span className="block text-xs text-muted-foreground">
                  Persist PR rows so you have history if you re-enable. PR
                  Quality scoring (when enabled) also runs.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="checksEnabled"
                value="1"
                defaultChecked={project.checksEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Publish GitHub status checks</span>
                <span className="block text-xs text-muted-foreground">
                  Mirrors the decision as a Check Run on each PR (success /
                  action_required / failure). Requires the App installation to
                  grant <code>checks:write</code>; silently no-ops otherwise.
                </span>
              </span>
            </label>
            <Button type="submit">Save gating</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bypass list</CardTitle>
          <CardDescription>
            GitHub logins (or glob patterns like <code>*[bot]</code>) whose PRs
            skip the application gate entirely. Useful for{" "}
            <code>dependabot[bot]</code>, <code>renovate[bot]</code>, etc.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateBypassSettings} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            <Textarea
              name="bypassHandles"
              rows={4}
              defaultValue={bypassHandles.join("\n")}
              placeholder="dependabot[bot]&#10;renovate[bot]&#10;trusted-friend"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              One per line. Supports <code>*</code> wildcards.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="bypassCollabs"
                value="1"
                defaultChecked={project.bypassCollabs}
                className="h-4 w-4 rounded border-border"
              />
              Also auto-bypass repository collaborators (checked via GitHub API)
            </label>
            <Button type="submit">Save bypass settings</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PR labels</CardTitle>
          <CardDescription>
            Labels applied to PRs based on the applicant&apos;s status. Created
            automatically the first time a label is applied.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateLabelSettings} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="labelsEnabled"
                value="1"
                defaultChecked={project.labelsEnabled}
                className="h-4 w-4 rounded border-border"
              />
              Apply labels to PRs
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="labelPending">Pending</Label>
                <Input
                  id="labelPending"
                  name="labelPending"
                  defaultValue={project.labelPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="labelApproved">Approved</Label>
                <Input
                  id="labelApproved"
                  name="labelApproved"
                  defaultValue={project.labelApproved}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="labelDenied">Denied</Label>
                <Input
                  id="labelDenied"
                  name="labelDenied"
                  defaultValue={project.labelDenied}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelEvaluate">Re-evaluate trigger</Label>
              <Input
                id="labelEvaluate"
                name="labelEvaluate"
                defaultValue={project.labelEvaluate}
              />
              <p className="text-xs text-muted-foreground">
                Admins add this label to a PR to force the checker to re-run
                (reopens closed-by-app PRs that now pass, or evaluates PRs
                opened before the App was installed). The bot strips the label
                after processing &mdash; even when labels are otherwise off.
              </p>
            </div>
            <Button type="submit">Save labels</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outbound webhooks</CardTitle>
          <CardDescription>
            Fan out application + PR events to one or more endpoints. Generic
            endpoints receive a JSON POST signed with HMAC-SHA256 in{" "}
            <code>X-ContribCheck-Signature</code>. Discord endpoints receive a
            Discord-formatted message; paste the channel webhook URL.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {webhookEndpoints.length > 0 && (
            <ul className="space-y-3">
              {webhookEndpoints.map((ep) => (
                <li
                  key={ep.id}
                  className="rounded-md border border-border p-3"
                >
                  <form
                    action={updateProjectWebhook}
                    className="grid grid-cols-1 gap-3 md:grid-cols-2"
                  >
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="endpointId" value={ep.id} />
                    <div className="space-y-1">
                      <Label htmlFor={`name-${ep.id}`}>Name (optional)</Label>
                      <Input
                        id={`name-${ep.id}`}
                        name="name"
                        defaultValue={ep.name ?? ""}
                        placeholder="e.g. #contributions"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`kind-${ep.id}`}>Type</Label>
                      <select
                        id={`kind-${ep.id}`}
                        name="kind"
                        defaultValue={ep.kind}
                        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                      >
                        <option value="generic">Generic JSON</option>
                        <option value="discord">Discord</option>
                      </select>
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label htmlFor={`url-${ep.id}`}>URL</Label>
                      <Input
                        id={`url-${ep.id}`}
                        name="url"
                        type="url"
                        required
                        defaultValue={ep.url}
                      />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label htmlFor={`secret-${ep.id}`}>
                        Secret (generic only — used to sign payloads)
                      </Label>
                      <Input
                        id={`secret-${ep.id}`}
                        name="secret"
                        defaultValue={ep.secret ?? ""}
                        placeholder="random-string-you-also-store-on-receiver"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={ep.enabled}
                      />
                      Enabled
                    </label>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                    </div>
                  </form>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={ep.enabled ? "success" : "warning"}>
                        {ep.enabled ? "active" : "disabled"}
                      </Badge>
                      <span className="font-mono">{ep.kind}</span>
                    </div>
                    <div className="flex gap-2">
                      <form action={sendTestWebhook}>
                        <input
                          type="hidden"
                          name="projectId"
                          value={project.id}
                        />
                        <input
                          type="hidden"
                          name="endpointId"
                          value={ep.id}
                        />
                        <Button type="submit" variant="outline" size="sm">
                          Send test
                        </Button>
                      </form>
                      <form action={deleteProjectWebhook}>
                        <input
                          type="hidden"
                          name="projectId"
                          value={project.id}
                        />
                        <input
                          type="hidden"
                          name="endpointId"
                          value={ep.id}
                        />
                        <Button
                          type="submit"
                          variant="outline"
                          size="sm"
                        >
                          Delete
                        </Button>
                      </form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            action={addProjectWebhook}
            className="grid grid-cols-1 gap-3 rounded-md border border-dashed border-border p-3 md:grid-cols-2"
          >
            <input type="hidden" name="projectId" value={project.id} />
            <div className="space-y-1">
              <Label htmlFor="new-name">Name (optional)</Label>
              <Input id="new-name" name="name" placeholder="e.g. ops Slack" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-kind">Type</Label>
              <select
                id="new-kind"
                name="kind"
                defaultValue="generic"
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="generic">Generic JSON</option>
                <option value="discord">Discord</option>
              </select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="new-url">URL</Label>
              <Input
                id="new-url"
                name="url"
                type="url"
                required
                placeholder="https://your-server.example/hook  or  https://discord.com/api/webhooks/..."
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="new-secret">
                Secret (generic only — leave blank for Discord)
              </Label>
              <Input
                id="new-secret"
                name="secret"
                placeholder="random-string-you-also-store-on-receiver"
              />
            </div>
            <div className="flex md:col-span-2">
              <Button type="submit" size="sm">
                Add endpoint
              </Button>
            </div>
          </form>

          {recentDeliveries.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">
                Recent deliveries
              </h4>
              <ul className="divide-y divide-border rounded-md border border-border">
                {recentDeliveries.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          d.status === "DELIVERED"
                            ? "success"
                            : d.status === "FAILED"
                              ? "destructive"
                              : "warning"
                        }
                      >
                        {d.status}
                      </Badge>
                      <span className="font-mono">{d.event}</span>
                      <span className="text-muted-foreground">
                        ({d.kind})
                      </span>
                      {d.responseCode != null && (
                        <span className="text-muted-foreground">
                          → {d.responseCode}
                        </span>
                      )}
                    </div>
                    <span className="text-muted-foreground">
                      {d.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
