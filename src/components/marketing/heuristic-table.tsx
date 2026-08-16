import { ALL_HEURISTICS } from "@/lib/quality/registry";
import type { Heuristic } from "@/lib/quality/types";
import { Badge } from "@/components/ui/badge";
import { SpecTable } from "@/components/marketing/spec-table";

export const GROUP_ORDER = [
  "size",
  "pr",
  "commit",
  "code",
  "diff",
  "account",
] as const;

export const GROUP_LABEL: Record<(typeof GROUP_ORDER)[number], string> = {
  size: "Size",
  pr: "PR text",
  commit: "Commits",
  code: "Code",
  diff: "Diff cohesion",
  account: "Account",
};

const WEIGHT_TONE = {
  1: "secondary",
  2: "warning",
  3: "warning",
  4: "destructive",
} as const;

const WEIGHT_LABEL = {
  1: "mild",
  2: "major",
  3: "critical",
  4: "blocker",
} as const;

function formatThreshold(h: Heuristic): string {
  const t = h.defaultThreshold;
  if (t === undefined || t === null) return "";
  if (Array.isArray(t)) return t.length ? t.join(", ") : "";
  return String(t);
}

/**
 * The heuristic catalogue, generated from ALL_HEURISTICS.
 *
 * Adding a heuristic to the registry updates this page for free, which matches
 * how the settings UI already works. Nothing here is retyped, so the public
 * documentation cannot drift from what actually runs.
 */
export function HeuristicTable() {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    items: ALL_HEURISTICS.filter((h) => h.group === group).sort(
      (a, b) => b.weight - a.weight,
    ),
  }));

  return (
    <div className="space-y-10">
      {groups.map((g) => (
        <section key={g.group}>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-sm font-semibold tracking-tight">{g.label}</h3>
            <span className="font-mono text-xs text-muted-foreground">
              {g.group} · {g.items.length} heuristics ·{" "}
              {g.items.filter((h) => h.defaultEnabled).length} on by default
            </span>
          </div>
          <SpecTable
            // Widths keep the identifier and weight columns from being
            // squeezed by the long description column.
            head={["Heuristic", "Weight", "Default", "What it looks for"]}
            widths={["16rem", "7rem", "6rem", undefined]}
            rows={g.items.map((h) => [
              <span key="id" className="block">
                <span className="block">{h.label}</span>
                <code className="text-[11px] font-normal text-muted-foreground">
                  {h.id}
                </code>
              </span>,
              <Badge
                key="w"
                variant={WEIGHT_TONE[h.weight]}
                className="whitespace-nowrap"
              >
                {h.weight} {WEIGHT_LABEL[h.weight]}
              </Badge>,
              <span key="d" className="text-xs whitespace-nowrap">
                {h.defaultEnabled ? "on" : "off"}
                {formatThreshold(h) ? (
                  <span className="block font-mono text-muted-foreground">
                    {formatThreshold(h)}
                  </span>
                ) : null}
              </span>,
              <span key="desc" className="text-xs">
                {h.description}
              </span>,
            ])}
          />
        </section>
      ))}
    </div>
  );
}

/** Compact per-group counts, for the landing page. */
export function HeuristicGroupSummary() {
  return (
    <SpecTable
      head={["Group", "Heuristics", "On by default"]}
      rows={GROUP_ORDER.map((g) => {
        const items = ALL_HEURISTICS.filter((h) => h.group === g);
        return [
          <span key="g">
            {GROUP_LABEL[g]}{" "}
            <code className="text-[11px] text-muted-foreground">{g}</code>
          </span>,
          <span key="n" className="tabular-nums">
            {items.length}
          </span>,
          <span key="e" className="tabular-nums">
            {items.filter((h) => h.defaultEnabled).length}
          </span>,
        ];
      })}
    />
  );
}
