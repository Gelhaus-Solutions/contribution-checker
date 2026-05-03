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

export function PeopleList({
  projectId,
  people,
}: {
  projectId: string;
  people: PersonRow[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "APPROVED" | "DENIED" | "REVOKED">(
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
      return (
        d.ghLogin.toLowerCase().includes(q) ||
        (d.reason ?? "").toLowerCase().includes(q) ||
        (d.decidedByLogin ?? "").toLowerCase().includes(q)
      );
    });
  }, [people, query, filter, source]);

  const counts = useMemo(() => {
    return {
      total: people.length,
      approved: people.filter((d) => d.status === "APPROVED").length,
      denied: people.filter((d) => d.status === "DENIED").length,
      revoked: people.filter((d) => d.status === "REVOKED").length,
    };
  }, [people]);

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
                        average across{" "}
                        {data.prs.filter((p) => p.quality && p.quality.score !== null).length}{" "}
                        scored PR(s)
                      </span>
                    </div>
                  </div>
                )}
              </section>
            )}

            <section>
              <h3 className="text-sm font-medium">PRs in this project</h3>
              {data.prs.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No PRs.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                  {data.prs.map((pr) => (
                    <li
                      key={`${pr.repoFullName}#${pr.prNumber}`}
                      className="px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          className="font-mono text-xs underline"
                          href={`https://github.com/${pr.repoFullName}/pull/${pr.prNumber}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {pr.repoFullName}#{pr.prNumber}
                        </a>
                        <Badge
                          variant={
                            pr.status === "APPROVED" || pr.status === "BYPASSED"
                              ? "success"
                              : pr.status === "DENIED"
                                ? "destructive"
                                : "warning"
                          }
                          className="text-[10px]"
                        >
                          {pr.status}
                        </Badge>
                        {pr.closedByApp && (
                          <Badge variant="outline" className="text-[10px]">
                            closed by app
                          </Badge>
                        )}
                        {pr.quality && (
                          <Badge
                            variant={
                              pr.quality.score === null
                                ? "outline"
                                : pr.quality.score < 50
                                  ? "destructive"
                                  : pr.quality.score < 75
                                    ? "warning"
                                    : "success"
                            }
                            className="text-[10px]"
                          >
                            quality{" "}
                            {pr.quality.score === null
                              ? "—"
                              : `${pr.quality.score}%`}
                          </Badge>
                        )}
                      </div>
                      {pr.quality && pr.quality.failed.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                          {pr.quality.failed.slice(0, 6).map((f) => (
                            <li key={f.id}>
                              <span className="font-medium">{f.label}</span>
                              {f.reason ? ` — ${f.reason}` : null}
                            </li>
                          ))}
                          {pr.quality.failed.length > 6 && (
                            <li>+{pr.quality.failed.length - 6} more</li>
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
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
