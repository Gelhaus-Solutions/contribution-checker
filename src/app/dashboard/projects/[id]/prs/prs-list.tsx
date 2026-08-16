"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useActionFeedback } from "@/components/ui/use-action-feedback";
import { StatusBadge } from "@/components/status-badge";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { SkeletonRows } from "@/components/ui/skeleton";
import {
  getPrOverview,
  rescanPrQuality,
  reEvaluatePrs,
  type PrOverview,
  type PrOverviewHeuristic,
} from "./actions";

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


export function PrsList({
  projectId,
  rows,
  repos,
  qualityEnabled,
  canEdit,
  initialFilters,
  initialOpenId,
}: {
  projectId: string;
  rows: PrRow[];
  repos: RepoOption[];
  qualityEnabled: boolean;
  canEdit: boolean;
  initialFilters: Filters;
  initialOpenId?: string | null;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);

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
          <Select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value as Filters["status"],
              }))
            }
          >
            <option value="ALL">All ({counts.total})</option>
            <option value="PENDING">Pending ({counts.pending})</option>
            <option value="APPROVED">Approved</option>
            <option value="BYPASSED">Bypassed</option>
            <option value="DENIED">Denied ({counts.denied})</option>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Repo</label>
          <Select
            value={filters.repoId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, repoId: e.target.value }))
            }
          >
            <option value="ALL">All repos</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Closed by app</label>
          <Select
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
          >
            <option value="ALL">Any</option>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </Select>
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
                <StatusBadge status={pr.status} />
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
                    {pr.quality.score === null ? "n/a" : `${pr.quality.score}%`}
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 px-2 text-[11px]"
                  onClick={() => setOpenId(pr.id)}
                >
                  Overview
                </Button>
                <span className="text-xs text-muted-foreground">
                  {pr.updatedAt.slice(0, 10)}
                </span>
              </div>
              {pr.quality && pr.quality.failed.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {pr.quality.failed.slice(0, 6).map((f) => (
                    <li key={f.id}>
                      <span className="font-medium">{f.label}</span>
                      {f.reason ? `: ${f.reason}` : null}
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

      {openId && (
        <PrOverviewDialog
          projectId={projectId}
          prCheckId={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
        />
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

function PrOverviewDialog({
  projectId,
  prCheckId,
  canEdit,
  onClose,
}: {
  projectId: string;
  prCheckId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<PrOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const feedback = useActionFeedback<"rescan" | "reeval">();

  const reload = () => {
    setError(null);
    return getPrOverview({ projectId, prCheckId })
      .then((d) => setData(d))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      );
  };

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getPrOverview({ projectId, prCheckId })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, prCheckId]);

  const onRescan = () => {
    if (!data || feedback.isAnyLoading) return;
    setFlash(null);
    feedback
      .run("rescan", async () => {
        const res = await rescanPrQuality({
          projectId,
          prCheckIds: [data.id],
        });
        if (res.scored > 0) {
          setFlash("Quality rescanned.");
        } else if (res.skipped > 0) {
          setFlash("Skipped: quality cannot run for this PR.");
        } else {
          setFlash("Rescan failed.");
        }
        await reload();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const onReevaluate = () => {
    if (!data || feedback.isAnyLoading) return;
    setFlash(null);
    feedback
      .run("reeval", async () => {
        const res = await reEvaluatePrs({
          projectId,
          prCheckIds: [data.id],
        });
        if (res.triggered > 0) {
          setFlash(
            `Re-evaluation triggered (label \"${data.evaluateLabel}\" added). The webhook will apply the new decision shortly.`
          );
        } else if (res.skipped > 0) {
          setFlash("Skipped: repo is not connected via the GitHub App.");
        } else {
          setFlash("Re-evaluate failed.");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width="xl">
        <DialogHeader>
          <DialogTitle>
            {data ? (
              <a
                href={data.ghUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline underline-offset-2"
              >
                {data.repoFullName}#{data.prNumber}
              </a>
            ) : (
              "PR overview"
            )}
          </DialogTitle>
          <DialogDescription>
            Gate decision, quality score and the actions available for this
            pull request.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        {error && <Alert variant="destructive">Error: {error}</Alert>}

        {!data && !error && <SkeletonRows rows={4} />}

        {data && (
          <div className="space-y-5">
            <section>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge status={data.status} />
                {data.closedByApp && (
                  <Badge variant="outline" className="text-[10px]">
                    closed by app
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px]">
                  {data.mode === "app" ? "App mode" : "CI mode"}
                </Badge>
                {!data.checkerEnabled && (
                  <Badge variant="secondary" className="text-[10px]">
                    checker disabled
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  by <span className="font-mono">{data.authorGhLogin}</span>
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <Field label="First seen" value={data.createdAt.slice(0, 10)} />
                <Field label="Last update" value={data.updatedAt.slice(0, 10)} />
                <Field
                  label="Head SHA"
                  value={data.headSha ? data.headSha.slice(0, 7) : "n/a"}
                  mono
                />
                <Field
                  label="Check Run"
                  value={data.checkRunId ? data.checkRunId : "n/a"}
                  mono
                />
                <Field
                  label="Author GH id"
                  value={String(data.authorGhId)}
                  mono
                />
                <Field
                  label="PR node id"
                  value={data.prNodeId.slice(0, 14) + "…"}
                  mono
                />
              </dl>
            </section>

            {data.currentDecision && (
              <section>
                <h3 className="text-sm font-medium">Current decision</h3>
                <div
                  className={
                    "mt-2 rounded-md border p-3 text-sm " +
                    (data.currentDecision.drifts
                      ? "border-warning/40 bg-warning/5"
                      : "border-border")
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        data.currentDecision.status === "APPROVED" ||
                        data.currentDecision.status === "BYPASSED"
                          ? "success"
                          : data.currentDecision.status === "DENIED"
                            ? "destructive"
                            : data.currentDecision.status === "PENDING"
                              ? "warning"
                              : "secondary"
                      }
                    >
                      {data.currentDecision.status}
                    </Badge>
                    {data.currentDecision.bypassReason && (
                      <span className="text-xs text-muted-foreground">
                        bypass: {data.currentDecision.bypassReason}
                      </span>
                    )}
                    {data.currentDecision.reason && (
                      <span className="text-xs text-muted-foreground">
                        {data.currentDecision.reason}
                      </span>
                    )}
                  </div>
                  {data.currentDecision.drifts && (
                    <p className="mt-2 text-xs">
                      Stored status (<span className="font-mono">{data.status}</span>)
                      differs from what the rules say now. Re-evaluate to apply
                      the new decision on GitHub.
                    </p>
                  )}
                </div>
              </section>
            )}

            <section>
              <h3 className="text-sm font-medium">Author totals</h3>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs sm:grid-cols-5">
                <Stat label="Total" value={data.authorStats.total} />
                <Stat label="Pending" value={data.authorStats.pending} />
                <Stat label="Approved" value={data.authorStats.approved} />
                <Stat label="Denied" value={data.authorStats.denied} />
                <Stat
                  label="Closed by app"
                  value={data.authorStats.closedByApp}
                />
              </dl>
            </section>

            {data.qualityEnabled && (
              <section>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">PR Quality</h3>
                  {data.quality && (
                    <span className="text-[10px] text-muted-foreground">
                      computed {data.quality.computedAt.slice(0, 10)}
                    </span>
                  )}
                </div>
                {!data.quality ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Not scored yet. Run a rescan to populate.
                  </p>
                ) : (
                  <div className="mt-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-2xl font-semibold">
                        {data.quality.score === null
                          ? "n/a"
                          : `${data.quality.score}%`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {data.quality.failedCount} fired /{" "}
                        {data.quality.totalRan} ran
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {data.quality.files} file(s)
                      {data.quality.filesTruncated && " (truncated)"} •{" "}
                      {data.quality.commits} commit(s)
                    </div>
                    <HeuristicsList heuristics={data.quality.heuristics} />
                  </div>
                )}
              </section>
            )}

            {flash && (
              <p className="text-xs text-muted-foreground">{flash}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2">
              {canEdit && data.qualityEnabled && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={feedback.isLoading("rescan")}
                  success={feedback.isSuccess("rescan")}
                  disabled={feedback.isAnyLoading || data.mode !== "app"}
                  onClick={onRescan}
                  title={
                    data.mode !== "app"
                      ? "CI-mode repos can only be scored from their workflow run."
                      : undefined
                  }
                >
                  Rescan quality
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={feedback.isLoading("reeval")}
                  success={feedback.isSuccess("reeval")}
                  disabled={feedback.isAnyLoading || data.mode !== "app"}
                  onClick={onReevaluate}
                  title={
                    data.mode !== "app"
                      ? "CI-mode repos re-evaluate on the next workflow run."
                      : undefined
                  }
                >
                  Re-evaluate
                </Button>
              )}
              <a
                className="ml-auto text-xs underline"
                href={`/dashboard/projects/${projectId}/prs?author=${encodeURIComponent(data.authorGhLogin)}`}
              >
                All PRs from {data.authorGhLogin} →
              </a>
            </div>
          </div>
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
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

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "text-xs"}>{value}</dd>
    </div>
  );
}

function HeuristicsList({ heuristics }: { heuristics: PrOverviewHeuristic[] }) {
  const [showPassed, setShowPassed] = useState(false);

  const ran = heuristics.filter((h) => h.ran);
  const failed = ran
    .filter((h) => h.failed)
    .sort((a, b) => b.weight - a.weight);
  const passed = ran
    .filter((h) => !h.failed)
    .sort((a, b) => b.weight - a.weight);

  if (ran.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        No heuristics ran for this PR.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {failed.length > 0 && (
        <ul className="space-y-1 text-xs">
          {failed.map((h) => (
            <HeuristicRow key={h.id} h={h} />
          ))}
        </ul>
      )}
      {passed.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowPassed((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showPassed ? "▾" : "▸"} {passed.length} passing
          </button>
          {showPassed && (
            <ul className="mt-1 space-y-1 text-xs">
              {passed.map((h) => (
                <HeuristicRow key={h.id} h={h} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function HeuristicRow({ h }: { h: PrOverviewHeuristic }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Badge
        variant={h.failed ? "destructive" : "success"}
        className="text-[10px]"
      >
        {h.failed ? "fail" : "pass"}
      </Badge>
      <span className="font-medium">{h.label}</span>
      <span className="text-[10px] text-muted-foreground">
        w{h.weight} • {h.group}
      </span>
      {h.reason && (
        <span className="text-[11px] text-muted-foreground">{h.reason}</span>
      )}
    </li>
  );
}
