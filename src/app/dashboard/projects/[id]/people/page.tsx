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
import { addManualDecision } from "./actions";
import { PeopleList, type PersonRow } from "./people-list";

export default async function ProjectPeople({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const [manual, applications] = await Promise.all([
    prisma.manualDecision.findMany({
      where: { projectId: id },
      include: { decidedBy: { select: { ghLogin: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.application.findMany({
      where: {
        projectId: id,
        status: { in: ["APPROVED", "DENIED"] },
      },
      include: {
        user: { select: { ghLogin: true } },
        decidedBy: { select: { ghLogin: true } },
      },
      orderBy: { decidedAt: "desc" },
      take: 500,
    }),
  ]);

  const rows: PersonRow[] = [
    ...manual.map<PersonRow>((d) => ({
      kind: "manual",
      id: d.id,
      ghLogin: d.ghLogin,
      status: d.status as "APPROVED" | "DENIED",
      reason: d.reason,
      decidedAt: d.updatedAt.toISOString(),
      decidedByLogin: d.decidedBy?.ghLogin ?? null,
    })),
    ...applications.map<PersonRow>((a) => ({
      kind: "application",
      id: a.id,
      ghLogin: a.user.ghLogin ?? "(no login)",
      status: a.status as "APPROVED" | "DENIED",
      reason: a.reason,
      decidedAt: (a.decidedAt ?? a.updatedAt).toISOString(),
      decidedByLogin: a.decidedBy?.ghLogin ?? null,
      applicationId: a.id,
    })),
  ].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">People</CardTitle>
          <CardDescription>
            Everyone who&apos;s been approved or denied — manual decisions and
            finalized applications. Click a row to view their PR history and
            quality breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PeopleList projectId={id} people={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
