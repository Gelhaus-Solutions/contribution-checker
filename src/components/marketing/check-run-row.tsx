import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import type { DecisionCheckPayload } from "@/lib/github/check-run";
import { cn } from "@/lib/cn";

const GLYPH = {
  success: { Icon: CheckCircle2, className: "text-success-strong" },
  action_required: { Icon: CircleAlert, className: "text-warning-strong" },
  failure: { Icon: XCircle, className: "text-destructive-strong" },
} as const;

/**
 * One GitHub-style check row.
 *
 * The payload is produced by buildDecisionCheckPayload, the same pure function
 * the webhook and the CI endpoint call, so these rows cannot drift from what
 * actually lands on a pull request.
 */
export function CheckRunRow({
  payload,
  className,
}: {
  payload: DecisionCheckPayload;
  className?: string;
}) {
  const glyph =
    GLYPH[(payload.conclusion ?? "action_required") as keyof typeof GLYPH] ??
    GLYPH.action_required;
  const { Icon } = glyph;

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0",
        className,
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", glyph.className)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs">{payload.name}</span>
          <span className="text-xs text-muted-foreground">
            {payload.title}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {payload.summary}
        </p>
      </div>
      <span className="shrink-0 self-center font-mono text-xs text-muted-foreground">
        {payload.conclusion}
      </span>
    </div>
  );
}

/** Groups check rows into a single bordered panel, as GitHub renders them. */
export function CheckRunPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      {children}
    </div>
  );
}
