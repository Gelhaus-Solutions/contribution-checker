"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionFeedback } from "@/components/ui/use-action-feedback";
import {
  removeManualDecision,
  getUserOverview,
  setApplicationStatus,
  setManualDecisionStatus,
  waiveClaForUser,
  type UserOverview,
} from "./actions";

type ManualEntry = {
  id: string;
  status: "APPROVED" | "DENIED";
  reason: string | null;
  decidedAt: string;
  decidedByLogin: string | null;
};

type ApplicationEntry = {
  id: string;
  status: "APPROVED" | "DENIED" | "PENDING";
  reason: string | null;
  decidedAt: string;
  decidedByLogin: string | null;
};

export type PersonRow = {
  ghLogin: string;
  manual?: ManualEntry;
  application?: ApplicationEntry;
  // Effective status — manual takes precedence per decide-pr.ts.
  status: "APPROVED" | "DENIED" | "PENDING";
  latestDecidedAt: string;
  latestDecidedByLogin: string | null;
};

const STATUS_VARIANT = {
  APPROVED: "success",
  DENIED: "destructive",
  PENDING: "warning",
} as const;

type SearchField = "ALL" | "login" | "reason" | "reviewer";

export function PeopleList({
  projectId,
  people,
  canEdit,
}: {
  projectId: string;
  people: PersonRow[];
  canEdit: boolean;
}) {
  const [query, setQuery] = useState("");
  const [searchField, setSearchField] = useState<SearchField>("ALL");
  const [filter, setFilter] = useState<"ALL" | "APPROVED" | "DENIED" | "PENDING">(
    "ALL"
  );
  const [source, setSource] = useState<"ALL" | "manual" | "application">("ALL");
  const [openLogin, setOpenLogin] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((d) => {
      if (filter !== "ALL" && d.status !== filter) return false;
      if (source === "manual" && !d.manual) return false;
      if (source === "application" && !d.application) return false;
      if (!q) return true;
      const login = d.ghLogin.toLowerCase();
      const reason = `${d.manual?.reason ?? ""} ${d.application?.reason ?? ""}`
        .toLowerCase();
      const reviewer = `${d.manual?.decidedByLogin ?? ""} ${d.application?.decidedByLogin ?? ""}`
        .toLowerCase();
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
      pending: people.filter((d) => d.status === "PENDING").length,
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
          {counts.pending > 0 && (
            <FilterChip
              label={`Pending ${counts.pending}`}
              active={filter === "PENDING"}
              onClick={() => setFilter("PENDING")}
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
              key={d.ghLogin}
              className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{d.ghLogin}</span>
                  <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                  {d.manual && (
                    <Badge variant="outline" className="text-xs">
                      Manual
                    </Badge>
                  )}
                  {d.application && (
                    <Badge variant="outline" className="text-xs">
                      Application
                    </Badge>
                  )}
                </div>
                {d.manual?.reason && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {d.application?.reason ? "Manual: " : ""}
                    {d.manual.reason}
                  </div>
                )}
                {d.application?.reason && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {d.manual?.reason ? "Application: " : ""}
                    {d.application.reason}
                  </div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {d.latestDecidedByLogin
                    ? `By ${d.latestDecidedByLogin}`
                    : "By system"}{" "}
                  on {d.latestDecidedAt.slice(0, 10)}
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
                {d.application && (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={`/dashboard/projects/${projectId}/applications/${d.application.id}`}
                    >
                      Application
                    </Link>
                  </Button>
                )}
                {d.manual && canEdit && (
                  <form action={removeManualDecision}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="decisionId" value={d.manual.id} />
                    <SubmitButton
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10"
                    >
                      Remove
                    </SubmitButton>
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
          canEdit={canEdit}
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
  canEdit,
  onClose,
}: {
  projectId: string;
  ghLogin: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<UserOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedback = useActionFeedback<string>();

  const reload = () => {
    setData(null);
    setError(null);
    return getUserOverview({ projectId, ghLogin })
      .then((d) => setData(d))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      );
  };

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

  const setStatus = (
    target: "PENDING" | "SUBMITTED" | "APPROVED" | "DENIED"
  ) => {
    if (!data?.application) return;
    const appId = data.application.id;
    feedback
      .run(`status:${target}`, async () => {
        await setApplicationStatus({
          projectId,
          applicationId: appId,
          target,
        });
        await reload();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const setManual = (status: "APPROVED" | "DENIED") => {
    if (!data?.manualDecision) return;
    const decisionId = data.manualDecision.id;
    feedback
      .run(`manual:${status}`, async () => {
        await setManualDecisionStatus({
          projectId,
          decisionId,
          status,
        });
        await reload();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const waiveCla = () => {
    const reason = window.prompt(
      `Reason for waiving the CLA for @${ghLogin}? They won't need to sign it.`,
      "Covered by a separate signed agreement"
    );
    if (!reason || !reason.trim()) return;
    feedback
      .run("waive-cla", async () => {
        await waiveClaForUser({ projectId, ghLogin, reason: reason.trim() });
        await reload();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Mirror approveApplication's CLA gate so forcing APPROVED can't throw an
  // unhandled gate error. record-only CLAs (required=false) never block.
  const claBlocksApproval =
    !!data?.cla && data.cla.required && !data.cla.satisfied;

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
                        data.application.derivedStatus === "APPROVED"
                          ? "success"
                          : data.application.derivedStatus === "DENIED"
                            ? "destructive"
                            : data.application.derivedStatus === "PENDING" ||
                                data.application.derivedStatus === "SUBMITTED"
                              ? "warning"
                              : "secondary"
                      }
                    >
                      {data.application.derivedStatus}
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
                  {canEdit && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Set state:
                      </span>
                      {(
                        ["PENDING", "SUBMITTED", "APPROVED", "DENIED"] as const
                      ).map((t) => (
                        <Button
                          key={t}
                          size="sm"
                          variant="outline"
                          loading={feedback.isLoading(`status:${t}`)}
                          success={feedback.isSuccess(`status:${t}`)}
                          disabled={
                            feedback.isAnyLoading ||
                            (t === "APPROVED" && claBlocksApproval)
                          }
                          title={
                            t === "APPROVED" && claBlocksApproval
                              ? "Applicant must sign the CLA before approval."
                              : undefined
                          }
                          onClick={() => setStatus(t)}
                          className="h-7 px-2 text-[11px]"
                        >
                          {t}
                        </Button>
                      ))}
                    </div>
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
                  {canEdit && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Set decision:
                      </span>
                      {(["APPROVED", "DENIED"] as const).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant="outline"
                          loading={feedback.isLoading(`manual:${s}`)}
                          success={feedback.isSuccess(`manual:${s}`)}
                          disabled={
                            feedback.isAnyLoading ||
                            data.manualDecision?.status === s
                          }
                          onClick={() => setManual(s)}
                          className="h-7 px-2 text-[11px]"
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {data.cla && (
              <section>
                <h3 className="text-sm font-medium">CLA</h3>
                <div className="mt-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        data.cla.satisfied
                          ? "success"
                          : data.cla.needsResign
                            ? "warning"
                            : data.cla.required
                              ? "destructive"
                              : "warning"
                      }
                    >
                      {data.cla.satisfied
                        ? "Signed"
                        : data.cla.needsResign
                          ? "Re-sign required"
                          : "Not signed"}
                    </Badge>
                    {data.cla.via && (
                      <Badge variant="outline" className="text-xs">
                        {data.cla.via === "icla"
                          ? "Individual"
                          : data.cla.via === "ccla"
                            ? "Corporate"
                            : "Waiver"}
                      </Badge>
                    )}
                    {!data.cla.required && (
                      <span className="text-xs text-muted-foreground">
                        record-only (not gating)
                      </span>
                    )}
                  </div>
                  {data.cla.via === "ccla" && data.cla.corporate && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Covered by Corporate CLA:{" "}
                      <span className="font-medium">
                        {data.cla.corporate.companyName}
                      </span>
                    </p>
                  )}
                  {data.cla.via === "waiver" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Exempt via an admin waiver.
                    </p>
                  )}
                  {data.cla.signature && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Individual signature: v{data.cla.signature.version}
                      {data.cla.currentVersion != null &&
                        ` (current v${data.cla.currentVersion})`}{" "}
                      • signed {data.cla.signature.signedAt.slice(0, 10)} as{" "}
                      <span className="font-medium">
                        {data.cla.signature.legalName}
                      </span>
                      {data.cla.signature.status === "REVOKED" && (
                        <span className="text-destructive"> • REVOKED</span>
                      )}
                    </p>
                  )}
                  {data.cla.blockedPrCount > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {data.cla.blockedPrCount} open PR(s) held open pending CLA.
                    </p>
                  )}
                  {canEdit && !data.cla.satisfied && (
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        loading={feedback.isLoading("waive-cla")}
                        success={feedback.isSuccess("waive-cla")}
                        disabled={feedback.isAnyLoading}
                        onClick={waiveCla}
                        className="h-7 px-2 text-[11px]"
                      >
                        Waive CLA for this user
                      </Button>
                    </div>
                  )}
                  {data.cla.via === "waiver" && canEdit && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Remove this exemption from the{" "}
                      <Link
                        href={`/dashboard/projects/${projectId}/cla/signatures`}
                        className="underline"
                      >
                        CLA waivers
                      </Link>{" "}
                      list.
                    </p>
                  )}
                </div>
              </section>
            )}

            {data.dco && (
              <section>
                <h3 className="text-sm font-medium">DCO</h3>
                <div className="mt-2 rounded-md border border-border p-3 text-sm">
                  <Badge
                    variant={
                      data.dco.blockedPrCount > 0 ? "destructive" : "success"
                    }
                  >
                    {data.dco.blockedPrCount > 0
                      ? `${data.dco.blockedPrCount} PR(s) missing sign-off`
                      : "No PRs blocked on sign-off"}
                  </Badge>
                  <p className="mt-2 text-xs text-muted-foreground">
                    DCO requires every commit to carry a{" "}
                    <span className="font-mono">Signed-off-by</span> trailer.
                  </p>
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
