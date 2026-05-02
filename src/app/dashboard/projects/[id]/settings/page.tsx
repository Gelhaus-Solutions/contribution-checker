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
  updateWebhookSettings,
  sendTestWebhook,
  updateLabelSettings,
  updateBypassSettings,
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

  const recentDeliveries = await prisma.webhookDelivery.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

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
              <Label htmlFor="cooldownDays">Denial cooldown (days)</Label>
              <Input
                id="cooldownDays"
                name="cooldownDays"
                type="number"
                min={0}
                defaultValue={project.cooldownDays ?? ""}
                placeholder="(blank = permanent until manually reset)"
              />
              <p className="text-xs text-muted-foreground">
                After a denial, applicant must wait this many days before re-applying. Leave blank for permanent denials.
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
            <Button type="submit">Save labels</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outbound webhook</CardTitle>
          <CardDescription>
            Receive a JSON POST on application + PR events. Payloads are signed
            with HMAC-SHA256 in the <code>X-ContribCheck-Signature</code> header.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={updateWebhookSettings} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="space-y-2">
              <Label htmlFor="webhookUrl">URL</Label>
              <Input
                id="webhookUrl"
                name="webhookUrl"
                type="url"
                defaultValue={project.webhookUrl ?? ""}
                placeholder="https://your-server.example/hook"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhookSecret">Secret (used to sign payloads)</Label>
              <Input
                id="webhookSecret"
                name="webhookSecret"
                defaultValue={project.webhookSecret ?? ""}
                placeholder="random-string-you-also-store-on-receiver"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit">Save webhook</Button>
            </div>
          </form>
          {project.webhookUrl && (
            <form action={sendTestWebhook}>
              <input type="hidden" name="projectId" value={project.id} />
              <Button type="submit" variant="outline" size="sm">
                Send test event
              </Button>
            </form>
          )}
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
