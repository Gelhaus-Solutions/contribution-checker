"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { removeManualDecision, getUserOverview, type UserOverview } from "./actions";

export type PersonRow = {
  kind: "manual" | "application";
  id: string;
  ghLogin: string;
  status: "APPROVED" | "DENIED";
  reason: string | null;
  decidedAt: string;
  decidedByLogin: string | null;
  applicationId?: string;
};

const STATUS_VARIANT = {
  APPROVED: "success",
  DENIED: "destructive",
} as const;

type SearchField = "ALL" | "login" | "reason" | "reviewer";

export function PeopleList({
  projectId,
  people,
}: {
  projectId: string;
  people: PersonRow[];
}) {
  const [query, setQuery] = useState("");
  const [searchField, setSearchField] = useState<SearchField>("ALL");
  const [filter, setFilter] = useState<"ALL" | "APPROVED" | "DENIED">(
    "ALL"
  );
  const [source, setSource] = useState<"ALL" | "manual" | "application">("ALL");
  const [openLogin, setOpenLogin] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((d) => {
      if (filter !== "ALL" && d.status !== filter) return false;
      if (source !== "ALL" && d.kind !== source) return false;
      if (!q) return true;
      const login = d.ghLogin.toLowerCase();
      const reason = (d.reason ?? "").toLowerCase();
      const reviewer = (d.decidedByLogin ?? "").toLowerCase();
      switch (searchField) {
        case "login":
          return login.includes(q);
        case "reason":
          return reason.includes(q);
        case "reviewer":
          return reviewer.includes(q);
        default:
          return login.includes(q) || reason.includes(q) || reviewer.includes(q);
      }
    });
  }, [people, query, searchField, filter, source]);

  const counts = useMemo(() => {
    return {
      total: people.length,
      approved: people.filter((d) => d.status === "APPROVED").length,
      denied: people.filter((d) => d.status === "DENIED").length,
    };
  }, [people]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-1 gap-2 sm:max-w-md">
          <select
            value={searchField}
            onChange={(e) => setSearchField(e.target.value as SearchField)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            aria-label="Search field"
          >
            <option value="ALL">All fields</option>
            <option value="login">Login</option>
            <option value="reason">Reason</option>
            <option value="reviewer">Reviewer</option>
          </select>
          <Input
            placeholder={
              searchField === "ALL"
                ? "Search login, reason, or reviewer..."
                : `Search by ${searchField}...`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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
          No people match your filters.
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenLogin(d.ghLogin)}
                >
                  View user
                </Button>
                {d.kind === "application" && d.applicationId && (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/dashboard/projects/${projectId}/applications/${d.applicationId}`}
                    >
                      Application
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

      {openLogin && (
        <UserOverviewDialog
          projectId={projectId}
          ghLogin={openLogin}
          onClose={() => setOpenLogin(null)}
        />
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

function UserOverviewDialog({
  projectId,
  ghLogin,
  onClose,
}: {
  projectId: string;
  ghLogin: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<UserOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getUserOverview({ projectId, ghLogin })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ghLogin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-md border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            <span className="font-mono">{ghLogin}</span>
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-destructive">Error: {error}</p>
        )}

        {!data && !error && (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        )}

        {data && (
          <div className="mt-4 space-y-5">
            {data.application && (
              <section>
                <h3 className="text-sm font-medium">Application</h3>
                <div className="mt-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        data.application.status === "APPROVED"
                          ? "success"
                          : data.application.status === "DENIED"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {data.application.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Submitted {data.application.createdAt.slice(0, 10)}
                      {data.application.decidedAt &&
                        ` • Decided ${data.application.decidedAt.slice(0, 10)}`}
                    </span>
                  </div>
                  {data.application.reason && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {data.application.reason}
                    </p>
                  )}
                  <div className="mt-3">
                    <Link
                      className="text-xs underline"
                      href={`/dashboard/projects/${projectId}/applications/${data.application.id}`}
                    >
                      Open original application →
                    </Link>
                  </div>
                </div>
              </section>
            )}

            {data.manualDecision && (
              <section>
                <h3 className="text-sm font-medium">Manual decision</h3>
                <div className="mt-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        data.manualDecision.status === "APPROVED"
                          ? "success"
                          : "destructive"
                      }
                    >
                      {data.manualDecision.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {data.manualDecision.decidedAt.slice(0, 10)}
                    </span>
                  </div>
                  {data.manualDecision.reason && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {data.manualDecision.reason}
                    </p>
                  )}
                </div>
              </section>
            )}

            <section>
              <h3 className="text-sm font-medium">PR stats</h3>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs sm:grid-cols-5">
                <Stat label="Total" value={data.prStats.total} />
                <Stat label="Pending" value={data.prStats.pending} />
                <Stat label="Approved" value={data.prStats.approved} />
                <Stat label="Denied" value={data.prStats.denied} />
                <Stat label="Closed by app" value={data.prStats.closedByApp} />
              </dl>
            </section>

            {data.qualityEnabled && (
              <section>
                <h3 className="text-sm font-medium">PR Quality</h3>
                {data.averageQuality === null ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No scored PRs yet for this user. Use the Quality tab to
                    backfill historical PRs.
                  </p>
                ) : (
                  <div className="mt-2 rounded-md border border-border p-3">
                    <div className="text-2xl font-semibold">
                      {data.averageQuality}%
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        average across {data.scoredPrCount} scored PR(s)
                      </span>
                    </div>
                  </div>
                )}
              </section>
            )}

            <div className="pt-2">
              <Link
                className="text-sm underline"
                href={`/dashboard/projects/${projectId}/prs?author=${encodeURIComponent(ghLogin)}`}
              >
                View all PRs from this user →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <dt className="text-[10px] uppercase text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold">{value}</dd>
    </div>
  );
}
