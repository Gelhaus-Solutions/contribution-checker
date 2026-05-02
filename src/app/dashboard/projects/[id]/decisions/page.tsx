import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { addManualDecision, removeManualDecision } from "./actions";

export default async function ProjectDecisions({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const decisions = await prisma.manualDecision.findMany({
    where: { projectId: id },
    include: { decidedBy: { select: { ghLogin: true } } },
    orderBy: [{ status: "asc" }, { ghLogin: "asc" }],
  });

  const approved = decisions.filter((d) => d.status === "APPROVED");
  const denied = decisions.filter((d) => d.status === "DENIED");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add manual decision</CardTitle>
          <CardDescription>
            Pre-approve or pre-deny a GitHub user without requiring them to
            apply. Manual decisions override applications and bypass lists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={addManualDecision}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="projectId" value={id} />
            <div className="flex-1 space-y-2">
              <Label htmlFor="ghLogin">GitHub login</Label>
              <Input
                id="ghLogin"
                name="ghLogin"
                placeholder="octocat"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Decision</Label>
              <select
                id="status"
                name="status"
                defaultValue="APPROVED"
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="APPROVED">Approve</option>
                <option value="DENIED">Deny</option>
              </select>
            </div>
            <div className="flex-1 space-y-2">
              <Label htmlFor="reason">Note (optional)</Label>
              <Input id="reason" name="reason" placeholder="Reason or context" />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      <DecisionList
        title="Approved"
        variant="success"
        items={approved}
        projectId={id}
      />
      <DecisionList
        title="Denied"
        variant="destructive"
        items={denied}
        projectId={id}
      />
    </div>
  );
}

type DecisionRow = {
  id: string;
  ghLogin: string;
  reason: string | null;
  createdAt: Date;
  decidedBy: { ghLogin: string | null } | null;
};

function DecisionList({
  title,
  variant,
  items,
  projectId,
}: {
  title: string;
  variant: "success" | "destructive";
  items: DecisionRow[];
  projectId: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Badge variant={variant}>{title}</Badge>
          <span className="text-muted-foreground">{items.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            None.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 px-6 py-3 text-sm"
              >
                <div>
                  <div className="font-mono">{d.ghLogin}</div>
                  {d.reason && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {d.reason}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Set by {d.decidedBy?.ghLogin ?? "unknown"} on{" "}
                    {d.createdAt.toISOString().slice(0, 10)}
                  </div>
                </div>
                <form action={removeManualDecision}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="decisionId" value={d.id} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
