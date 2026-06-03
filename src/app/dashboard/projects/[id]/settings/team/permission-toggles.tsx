"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { setMemberPermissionAction } from "./actions";

export type ToggleCandidate = { id: string; label: string; granted: boolean };

/**
 * Per-member "extra access" toggles: grant a reviewer explicit leaf permissions
 * (e.g. View audit log) beyond their role preset. Each toggle dual-writes to
 * Stack Auth via the server action; the page revalidates to reflect the new
 * cached set.
 */
export function PermissionToggles({
  projectId,
  memberId,
  candidates,
}: {
  projectId: string;
  memberId: string;
  candidates: ToggleCandidate[];
}) {
  const [pending, startTransition] = React.useTransition();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  if (candidates.length === 0) return null;

  function toggle(c: ToggleCandidate) {
    setBusyId(c.id);
    startTransition(async () => {
      try {
        await setMemberPermissionAction({
          projectId,
          memberId,
          permission: c.id,
          granted: !c.granted,
        });
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        Extra access
        <span className="ml-1 text-muted-foreground/70 group-open:hidden">
          ({candidates.filter((c) => c.granted).length} granted)
        </span>
      </summary>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={pending && busyId === c.id}
            onClick={() => toggle(c)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50",
              c.granted
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {c.granted ? (
              <Check className="h-3 w-3" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            {c.label}
          </button>
        ))}
      </div>
    </details>
  );
}
