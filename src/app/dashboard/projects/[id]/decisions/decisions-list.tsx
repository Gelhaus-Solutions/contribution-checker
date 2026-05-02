"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { removeManualDecision } from "./actions";

export type DecisionRow = {
  kind: "manual" | "application";
  id: string;
  ghLogin: string;
  status: "APPROVED" | "DENIED" | "REVOKED";
  reason: string | null;
  decidedAt: string;
  decidedByLogin: string | null;
  applicationId?: string;
};

const STATUS_VARIANT = {
  APPROVED: "success",
  DENIED: "destructive",
  REVOKED: "secondary",
} as const;

export function DecisionsList({
  projectId,
  decisions,
}: {
  projectId: string;
  decisions: DecisionRow[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "APPROVED" | "DENIED" | "REVOKED">(
    "ALL"
  );
  const [source, setSource] = useState<"ALL" | "manual" | "application">("ALL");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decisions.filter((d) => {
      if (filter !== "ALL" && d.status !== filter) return false;
      if (source !== "ALL" && d.kind !== source) return false;
      if (!q) return true;
      return (
        d.ghLogin.toLowerCase().includes(q) ||
        (d.reason ?? "").toLowerCase().includes(q) ||
        (d.decidedByLogin ?? "").toLowerCase().includes(q)
      );
    });
  }, [decisions, query, filter, source]);

  const counts = useMemo(() => {
    return {
      total: decisions.length,
      approved: decisions.filter((d) => d.status === "APPROVED").length,
      denied: decisions.filter((d) => d.status === "DENIED").length,
      revoked: decisions.filter((d) => d.status === "REVOKED").length,
    };
  }, [decisions]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search by login, reason, or reviewer..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-1">
          <FilterChip
            label={`All ${counts.total}`}
            active={filter === "ALL"}
            onClick={() => setFilter("ALL")}
          />
          <FilterChip
            label={`Approved ${counts.approved}`}
            active={filter === "APPROVED"}
            onClick={() => setFilter("APPROVED")}
          />
          <FilterChip
            label={`Denied ${counts.denied}`}
            active={filter === "DENIED"}
            onClick={() => setFilter("DENIED")}
          />
          {counts.revoked > 0 && (
            <FilterChip
              label={`Revoked ${counts.revoked}`}
              active={filter === "REVOKED"}
              onClick={() => setFilter("REVOKED")}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1 sm:ml-auto">
          <FilterChip
            label="Any source"
            active={source === "ALL"}
            onClick={() => setSource("ALL")}
          />
          <FilterChip
            label="Manual"
            active={source === "manual"}
            onClick={() => setSource("manual")}
          />
          <FilterChip
            label="From application"
            active={source === "application"}
            onClick={() => setSource("application")}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-border px-6 py-10 text-center text-sm text-muted-foreground">
          No decisions match your filters.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {filtered.map((d) => (
            <li
              key={`${d.kind}:${d.id}`}
              className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{d.ghLogin}</span>
                  <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                  <Badge variant="outline" className="text-xs">
                    {d.kind === "manual" ? "Manual" : "Application"}
                  </Badge>
                </div>
                {d.reason && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {d.reason}
                  </div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {d.decidedByLogin ? `By ${d.decidedByLogin}` : "By system"} on{" "}
                  {d.decidedAt.slice(0, 10)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {d.kind === "application" && d.applicationId && (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/dashboard/projects/${projectId}/applications/${d.applicationId}`}
                    >
                      View application
                    </Link>
                  </Button>
                )}
                {d.kind === "manual" && (
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
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-md bg-muted px-2.5 py-1 text-xs font-medium"
          : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
      }
    >
      {label}
    </button>
  );
}
