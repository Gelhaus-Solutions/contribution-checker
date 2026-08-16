"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import type { ClaActionState } from "../actions";

// The corporate roster server actions (`addRosterMembers`,
// `revokeRosterMember`) return the shared `ClaActionState`. A partial bulk add
// (some logins skipped because disputed) is surfaced through the `error`
// channel with a descriptive reason; the client only reads `status`/`reason`.
const INITIAL: ClaActionState = { status: "idle" };

export type RosterMember = {
  id: string;
  ghLogin: string;
  ghId: number | null;
  status: string; // "ACTIVE" | "REVOKED" | "DISPUTED"
  disputeNote: string | null;
  addedAt: string; // ISO date (YYYY-MM-DD)
};


export function RosterManager({
  corporateId,
  members,
  companyName,
  addAction,
  revokeAction,
}: {
  corporateId: string;
  members: RosterMember[];
  companyName: string;
  addAction: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
  revokeAction: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const active = members.filter((m) => m.status === "ACTIVE");
  const disputed = members.filter((m) => m.status === "DISPUTED");
  const revoked = members.filter((m) => m.status === "REVOKED");

  return (
    <div className="space-y-6">
      <AddRosterForm corporateId={corporateId} action={addAction} />

      {active.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            Covered contributors ({active.length})
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {active.map((m) => (
              <ActiveRow
                key={m.id}
                member={m}
                corporateId={corporateId}
                action={revokeAction}
              />
            ))}
          </ul>
        </section>
      )}

      {disputed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            Disputed ({disputed.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            These contributors disputed being listed under {companyName}. Their
            coverage is suspended and they cannot be re-added unless they
            consent.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {disputed.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <Badge variant="warning" className="text-[10px]">
                  DISPUTED
                </Badge>
                <span className="font-mono">@{m.ghLogin}</span>
                {m.disputeNote && (
                  <span className="text-xs text-muted-foreground">
                    ({m.disputeNote})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {revoked.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Removed ({revoked.length})
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {revoked.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
              >
                <Badge variant="secondary" className="text-[10px]">
                  REMOVED
                </Badge>
                <span className="font-mono">@{m.ghLogin}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {active.length === 0 && disputed.length === 0 && revoked.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No contributors on the roster yet. Add GitHub usernames above to cover
          them under your corporate CLA.
        </p>
      )}
    </div>
  );
}

function AddRosterForm({
  corporateId,
  action,
}: {
  corporateId: string;
  action: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const [state, dispatch] = useActionState<ClaActionState, FormData>(
    action,
    INITIAL
  );

  return (
    <form action={dispatch} className="space-y-3">
      <input type="hidden" name="corporateId" value={corporateId} />
      <div className="space-y-1.5">
        <Label htmlFor="ghLogins">Add contributors</Label>
        <Textarea
          id="ghLogins"
          name="ghLogins"
          rows={4}
          required
          placeholder={"octocat\nmonalisa, hubot\n…"}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          One GitHub username per line, or comma-separated. Bulk paste is
          supported.
        </p>
      </div>
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}
      {state.status === "ok" && (
        <p className="text-sm text-success">Roster updated.</p>
      )}
      <SubmitButton>Add to roster</SubmitButton>
    </form>
  );
}

function ActiveRow({
  member,
  corporateId,
  action,
}: {
  member: RosterMember;
  corporateId: string;
  action: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const [state, dispatch, pending] = useActionState<ClaActionState, FormData>(
    action,
    INITIAL
  );

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <StatusBadge status={member.status} />
      <span className="font-mono">@{member.ghLogin}</span>
      <span className="text-xs text-muted-foreground">
        added {member.addedAt}
      </span>
      <form action={dispatch} className="ml-auto">
        <input type="hidden" name="corporateId" value={corporateId} />
        <input type="hidden" name="memberId" value={member.id} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          loading={pending}
        >
          Remove
        </Button>
      </form>
      {state.status === "error" && (
        <p className="w-full text-xs text-destructive">{state.reason}</p>
      )}
    </li>
  );
}
