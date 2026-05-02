import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { parseFormSchema } from "@/lib/applications/schema";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { approveAction, denyAction, revokeAction, addNoteAction } from "./actions";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  SUBMITTED: "warning",
  APPROVED: "success",
  DENIED: "destructive",
  REVOKED: "secondary",
};

export default async function ApplicationDetail({
  params,
}: {
  params: Promise<{ id: string; appId: string }>;
}) {
  const { id, appId } = await params;
  const { session } = await requireProjectRole(id, "REVIEWER");

  const app = await prisma.application.findFirst({
    where: { id: appId, projectId: id },
    include: {
      user: { select: { id: true, ghLogin: true, name: true, image: true, email: true } },
      decidedBy: { select: { ghLogin: true } },
      project: { select: { id: true, formSchema: true } },
      notes: {
        include: { author: { select: { ghLogin: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!app) notFound();

  const fields = parseFormSchema(app.project.formSchema);
  const answers = (() => {
    try {
      return JSON.parse(app.answers) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const isPending = app.status === "SUBMITTED";
  const isApproved = app.status === "APPROVED";
  const isRevoked = app.status === "REVOKED";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href={`/dashboard/projects/${id}/applications`}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to queue
        </Link>
        <Badge variant={STATUS_VARIANT[app.status] ?? "secondary"}>
          {app.status}
        </Badge>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            {app.user.image && (
              <Image
                src={app.user.image}
                alt={app.user.ghLogin ?? ""}
                width={40}
                height={40}
                className="rounded-full"
              />
            )}
            <div>
              <CardTitle className="text-base">
                {app.user.ghLogin ?? "(no login)"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">{app.user.name}</p>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Submitted {app.createdAt.toISOString().slice(0, 10)}</div>
            {app.decidedAt && (
              <div>
                {app.status === "APPROVED" ? "Approved" : app.status === "DENIED" ? "Denied" : "Revoked"} by{" "}
                {app.decidedBy?.ghLogin ?? "system"} on{" "}
                {app.decidedAt.toISOString().slice(0, 10)}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The form had no fields when this application was submitted.
            </p>
          ) : (
            fields.map((f) => (
              <div key={f.id}>
                <Label className="text-xs">{f.label}</Label>
                <div className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  {f.type === "checkbox"
                    ? answers[f.id]
                      ? "✓ Yes"
                      : "✗ No"
                    : (() => {
                        const v = answers[f.id];
                        return typeof v === "string" && v.length > 0 ? v : "—";
                      })()}
                </div>
              </div>
            ))
          )}
          {app.reason && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <span className="font-medium">Decision note: </span>
              {app.reason}
            </div>
          )}
        </CardContent>
      </Card>

      {(isPending || isApproved || isRevoked) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isPending
                ? "Decide"
                : isApproved
                  ? "Revoke approval"
                  : "Reinstate approval"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPending ? (
              <>
                <form action={approveAction} className="space-y-2">
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="appId" value={app.id} />
                  <Label htmlFor="reason-approve" className="text-xs">
                    Optional note
                  </Label>
                  <Textarea
                    id="reason-approve"
                    name="reason"
                    rows={2}
                    placeholder="Welcome aboard…"
                  />
                  <Button type="submit" variant="success">
                    Approve
                  </Button>
                </form>
                <form action={denyAction} className="space-y-2">
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="appId" value={app.id} />
                  <Label htmlFor="reason-deny" className="text-xs">
                    Reason (shown to applicant)
                  </Label>
                  <Textarea
                    id="reason-deny"
                    name="reason"
                    rows={2}
                    placeholder="Optional"
                  />
                  <Button type="submit" variant="destructive">
                    Deny
                  </Button>
                </form>
              </>
            ) : isApproved ? (
              <form action={revokeAction} className="space-y-2">
                <input type="hidden" name="projectId" value={id} />
                <input type="hidden" name="appId" value={app.id} />
                <Label htmlFor="reason-revoke" className="text-xs">
                  Reason (shown to applicant)
                </Label>
                <Textarea
                  id="reason-revoke"
                  name="reason"
                  rows={2}
                  placeholder="Why revoke?"
                />
                <p className="text-xs text-muted-foreground">
                  Revoking will close any of their currently open PRs across
                  this project&apos;s repos.
                </p>
                <Button type="submit" variant="destructive">
                  Revoke approval
                </Button>
              </form>
            ) : (
              <form action={approveAction} className="space-y-2">
                <input type="hidden" name="projectId" value={id} />
                <input type="hidden" name="appId" value={app.id} />
                <Label htmlFor="reason-reapprove" className="text-xs">
                  Optional note
                </Label>
                <Textarea
                  id="reason-reapprove"
                  name="reason"
                  rows={2}
                  placeholder="Welcome back…"
                />
                <p className="text-xs text-muted-foreground">
                  Re-approving will reopen any PRs that were closed when
                  approval was revoked.
                </p>
                <Button type="submit" variant="success">
                  Re-approve
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internal notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {app.notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notes yet. Notes are visible only to project members.
            </p>
          ) : (
            <ul className="space-y-3">
              {app.notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                >
                  <div className="mb-1 text-xs text-muted-foreground">
                    {n.author.ghLogin} ·{" "}
                    {n.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                  </div>
                  <div className="whitespace-pre-wrap">{n.body}</div>
                </li>
              ))}
            </ul>
          )}
          <form action={addNoteAction} className="space-y-2">
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="appId" value={app.id} />
            <input type="hidden" name="actorId" value={session.user.id} />
            <Textarea
              name="body"
              rows={2}
              required
              placeholder="Add a note for the team…"
            />
            <Button type="submit" size="sm" variant="outline">
              Post note
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
