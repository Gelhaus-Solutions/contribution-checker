"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type PrStatus = "PENDING" | "APPROVED" | "DENIED" | "BYPASSED";

export type PrRow = {
  id: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  authorGhLogin: string;
  status: PrStatus;
  closedByApp: boolean;
  updatedAt: string;
  quality: {
    score: number | null;
    failed: Array<{ id: string; label: string; reason?: string }>;
  } | null;
};

export type RepoOption = { id: string; fullName: string };

type Filters = {
  author: string;
  prNumber: string;
  status: "ALL" | PrStatus;
  repoId: string;
  closedByApp: boolean | null;
  minScore: number | null;
  maxScore: number | null;
};

const PAGE_SIZE = 20;

const STATUS_VARIANT: Record<
  PrStatus,
  "success" | "destructive" | "warning" | "secondary"
> = {
  APPROVED: "success",
  BYPASSED: "success",
  DENIED: "destructive",
  PENDING: "warning",
};

export function PrsList({
  rows,
  repos,
  qualityEnabled,
  initialFilters,
}: {
  projectId: string;
  rows: PrRow[];
  repos: RepoOption[];
  qualityEnabled: boolean;
  initialFilters: Filters;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const author = filters.author.trim().toLowerCase();
    const prNumberQuery = filters.prNumber.trim();
    return rows.filter((r) => {
      if (author && !r.authorGhLogin.toLowerCase().includes(author)) return false;
      if (prNumberQuery && !String(r.prNumber).includes(prNumberQuery)) return false;
      if (filters.status !== "ALL" && r.status !== filters.status) return false;
      if (filters.repoId !== "ALL" && r.repoId !== filters.repoId) return false;
      if (filters.closedByApp !== null && r.closedByApp !== filters.closedByApp)
        return false;
      if (qualityEnabled) {
        const score = r.quality?.score ?? null;
        if (filters.minScore !== null) {
          if (score === null || score < filters.minScore) return false;
        }
        if (filters.maxScore !== null) {
          if (score === null || score > filters.maxScore) return false;
        }
      }
      return true;
    });
  }, [rows, filters, qualityEnabled]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  useEffect(() => {
    setPage(1);
  }, [filters]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      pending: rows.filter((r) => r.status === "PENDING").length,
      approved: rows.filter(
        (r) => r.status === "APPROVED" || r.status === "BYPASSED"
      ).length,
      denied: rows.filter((r) => r.status === "DENIED").length,
    }),
    [rows]
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Author login</label>
          <Input
            placeholder="octocat"
            value={filters.author}
            onChange={(e) =>
              setFilters((f) => ({ ...f, author: e.target.value }))
            }
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">PR number</label>
          <Input
            placeholder="123"
            inputMode="numeric"
            value={filters.prNumber}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                prNumber: e.target.value.replace(/[^0-9]/g, ""),
              }))
            }
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value as Filters["status"],
              }))
            }
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="ALL">All ({counts.total})</option>
            <option value="PENDING">Pending ({counts.pending})</option>
            <option value="APPROVED">Approved</option>
            <option value="BYPASSED">Bypassed</option>
            <option value="DENIED">Denied ({counts.denied})</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Repo</label>
          <select
            value={filters.repoId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, repoId: e.target.value }))
            }
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="ALL">All repos</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Closed by app</label>
          <select
            value={
              filters.closedByApp === null
                ? "ALL"
                : filters.closedByApp
                  ? "1"
                  : "0"
            }
            onChange={(e) => {
              const v = e.target.value;
              setFilters((f) => ({
                ...f,
                closedByApp: v === "ALL" ? null : v === "1",
              }));
            }}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="ALL">Any</option>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        {qualityEnabled && (
          <>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Min score (0–100)
              </label>
              <Input
                type="number"
                min={0}
                max={100}
                value={filters.minScore ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    minScore: parseScore(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Max score (0–100)
              </label>
              <Input
                type="number"
                min={0}
                max={100}
                value={filters.maxScore ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    maxScore: parseScore(e.target.value),
                  }))
                }
              />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {filtered.length} of {rows.length} PR(s)
        </span>
        {filtered.length > 0 && (
          <span>
            Page {currentPage} of {totalPages}
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-border px-6 py-10 text-center text-sm text-muted-foreground">
          No PRs match your filters.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {pageRows.map((pr) => (
            <li key={pr.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="font-mono text-xs underline"
                  href={`https://github.com/${pr.repoFullName}/pull/${pr.prNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {pr.repoFullName}#{pr.prNumber}
                </a>
                <span className="text-xs text-muted-foreground">
                  by <span className="font-mono">{pr.authorGhLogin}</span>
                </span>
                <Badge variant={STATUS_VARIANT[pr.status]} className="text-[10px]">
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
                    {pr.quality.score === null ? "—" : `${pr.quality.score}%`}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {pr.updatedAt.slice(0, 10)}
                </span>
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

      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Showing {(currentPage - 1) * PAGE_SIZE + 1}–
            {Math.min(currentPage * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function parseScore(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
