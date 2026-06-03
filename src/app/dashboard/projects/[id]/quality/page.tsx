import { prisma } from "@/lib/db";
import { requireProjectPermission, roleAtLeast } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { ALL_HEURISTICS } from "@/lib/quality/registry";
import {
  parseQualityConfig,
  parseHoneypots,
} from "@/lib/quality/registry";
import {
  updateQualityCore,
  updateQualityHeuristics,
  backfillQuality,
} from "./actions";

const groupOrder = ["size", "pr", "commit", "code", "diff", "account"] as const;
const groupLabel: Record<(typeof groupOrder)[number], string> = {
  size: "Size",
  pr: "PR text",
  commit: "Commits",
  code: "Code",
  diff: "Diff cohesion",
  account: "Account",
};

export default async function ProjectQualityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { role } = await requireProjectPermission(id, "project_quality_view");
  const canEdit = roleAtLeast(role, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      qualityEnabled: true,
      qualityConfig: true,
      qualityCommentMin: true,
      prTemplateHoneypots: true,
      qualityTemplateMatchPct: true,
    },
  });
  if (!project) return null;

  const config = parseQualityConfig(project.qualityConfig);
  const honeypots = parseHoneypots(project.prTemplateHoneypots);

  const grouped = groupOrder.map((group) => ({
    group,
    label: groupLabel[group],
    items: ALL_HEURISTICS.filter((h) => h.group === group),
  }));

  return (
    <div className="space-y-6">
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You have reviewer access. Editing quality settings requires admin
          permissions.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">PR Quality scoring</CardTitle>
          <CardDescription>
            Heuristic-based 0–100% score per PR. Heuristic weights are fixed;
            you can toggle each heuristic and tune its threshold. Score is
            computed on the fly from stored signals, so config changes apply
            instantly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateQualityCore} className="space-y-4">
            <fieldset disabled={!canEdit} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="qualityEnabled"
                value="1"
                defaultChecked={project.qualityEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Quality scoring enabled</span>
                <span className="block text-xs text-muted-foreground">
                  When on, every tracked PR is scored on open and on push.
                </span>
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="qualityCommentMin">Public comment threshold</Label>
                <Input
                  id="qualityCommentMin"
                  name="qualityCommentMin"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={project.qualityCommentMin}
                />
                <p className="text-xs text-muted-foreground">
                  Post a public PR comment with the breakdown when score &lt;
                  this value. Default 20. Set to 0 to disable.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qualityTemplateMatchPct">
                  Template match strictness (%)
                </Label>
                <Input
                  id="qualityTemplateMatchPct"
                  name="qualityTemplateMatchPct"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={project.qualityTemplateMatchPct}
                />
                <p className="text-xs text-muted-foreground">
                  How strict the <code>pr.uses_template</code> heuristic is
                  when matching checkbox / heading text against the body.
                  100 = exact substring; 80 (default) tolerates typos and
                  edits via word-overlap.
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="prTemplateHoneypots">PR template honeypots</Label>
                <Textarea
                  id="prTemplateHoneypots"
                  name="prTemplateHoneypots"
                  rows={3}
                  defaultValue={honeypots.join("\n")}
                  placeholder="contrib-check-honeypot-token-1&#10;another-bait-string"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  One per line. Bury these inside an HTML comment in the PR
                  template. Bots that copy the template wholesale will trip
                  the <code>pr.honeypot_hit</code> heuristic.
                </p>
              </div>
            </div>
            <SubmitButton disabled={!canEdit}>Save</SubmitButton>
            </fieldset>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Heuristics</CardTitle>
          <CardDescription>
            Toggle each heuristic and tune its threshold. Weight is shown for
            transparency but cannot be changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateQualityHeuristics} className="space-y-6">
            <fieldset disabled={!canEdit} className="space-y-6">
            <input type="hidden" name="projectId" value={project.id} />
            {grouped.map((g) => (
              <section key={g.group} className="space-y-3">
                <h3 className="text-sm font-semibold">{g.label}</h3>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {g.items.map((h) => {
                    const setting = config[h.id];
                    const enabled =
                      setting?.enabled !== undefined
                        ? setting.enabled
                        : h.defaultEnabled;
                    const threshold =
                      setting?.threshold !== undefined
                        ? setting.threshold
                        : h.defaultThreshold;
                    return (
                      <li
                        key={h.id}
                        className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <label className="flex flex-1 items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            name={`enabled.${h.id}`}
                            value="1"
                            defaultChecked={enabled}
                            className="mt-0.5 h-4 w-4 rounded border-border"
                          />
                          <span>
                            <span className="font-medium">{h.label}</span>{" "}
                            <Badge
                              variant="outline"
                              className="ml-1 text-[10px]"
                            >
                              w{h.weight}
                            </Badge>
                            <span className="block text-xs text-muted-foreground">
                              {h.description}
                            </span>
                            <code className="text-[10px] text-muted-foreground/70">
                              {h.id}
                            </code>
                          </span>
                        </label>
                        {h.thresholdKind === "number" && (
                          <div className="w-full sm:w-40">
                            <Input
                              type="number"
                              name={`threshold.${h.id}`}
                              defaultValue={
                                typeof threshold === "number"
                                  ? threshold
                                  : typeof h.defaultThreshold === "number"
                                    ? h.defaultThreshold
                                    : undefined
                              }
                              placeholder="threshold"
                            />
                          </div>
                        )}
                        {h.thresholdKind === "stringList" && (
                          <div className="w-full sm:w-72">
                            <Textarea
                              name={`threshold.${h.id}`}
                              rows={3}
                              defaultValue={
                                Array.isArray(threshold)
                                  ? threshold.join("\n")
                                  : Array.isArray(h.defaultThreshold)
                                    ? h.defaultThreshold.join("\n")
                                    : ""
                              }
                              className="font-mono text-xs"
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            <SubmitButton disabled={!canEdit}>Save heuristics</SubmitButton>
            </fieldset>
          </form>
        </CardContent>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Backfill</CardTitle>
            <CardDescription>
              Score every existing PR in this project (max 200 per run). Useful
              after enabling quality scoring or after large config changes that
              require re-fetching diffs (e.g. switching account-level
              heuristics on).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={backfillQuality}>
              <input type="hidden" name="projectId" value={project.id} />
              <SubmitButton variant="outline" disabled={!project.qualityEnabled}>
                Run backfill
              </SubmitButton>
              {!project.qualityEnabled && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Enable quality scoring above before backfilling.
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
