"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { useActionFeedback } from "@/components/ui/use-action-feedback";
import { cn } from "@/lib/cn";
import type { QaStatus } from "@/lib/qa/types";
import { setQaStatus } from "./actions";

export type QaBoardItem = {
  id: string;
  key: string;
  kind: string;
  prNumber: number | null;
  title: string;
  authorLogin: string | null;
  summary: string | null;
  qaSteps: string | null;
  labels: string[];
  linkedIssues: number[];
  qaStatus: QaStatus;
  qaNotes: string | null;
  qaAt: string | null;
  qaBy: string | null;
  mergedAt: string | null;
  droppedAt: string | null;
  externalUrl: string | null;
};

type Filter = "open" | "all" | "failed";

/**
 * The board. Verdicts are per-row and immediate, so this calls the server
 * actions directly through `useActionFeedback` rather than wrapping every row
 * in a form: a checklist that needed a full page navigation per tick would not
 * get used on a thirty-item batch.
 */
export function QaBoard({
  projectId,
  items,
  repoFullName,
  canVerify,
}: {
  projectId: string;
  items: QaBoardItem[];
  repoFullName: string;
  canVerify: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failing, setFailing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fb = useActionFeedback<string>();

  const visible = useMemo(() => {
    const live = items.filter((i) => !i.droppedAt);
    const rows =
      filter === "all"
        ? items
        : filter === "failed"
          ? live.filter((i) => i.qaStatus === "QA_FAILED")
          : live.filter(
              (i) =>
                i.qaStatus === "QA_PENDING" || i.qaStatus === "QA_IN_REVIEW",
            );
    // Grouped by the issue they implement where the PRs say so, because a
    // reviewer verifies a feature, not a diff. Falls back to PR order.
    return [...rows].sort((a, b) => {
      const ai = a.linkedIssues[0] ?? Number.MAX_SAFE_INTEGER;
      const bi = b.linkedIssues[0] ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return (a.prNumber ?? 0) - (b.prNumber ?? 0);
    });
  }, [items, filter]);

  const droppedCount = items.filter((i) => i.droppedAt).length;

  async function apply(item: QaBoardItem, status: QaStatus, notes?: string) {
    setError(null);
    try {
      await fb.run(item.id, () =>
        setQaStatus({ projectId, itemIds: [item.id], status, notes }),
      );
      setFailing(null);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that verdict.");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        {(["open", "failed", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-md px-2 py-1 text-xs transition-colors",
              filter === f
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {f === "open" ? "Needs QA" : f === "failed" ? "Failed" : "All"}
          </button>
        ))}
        {droppedCount > 0 && filter === "all" ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {droppedCount} no longer in this batch
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive-strong">
          {error}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          variant="row"
          title={
            filter === "open"
              ? "Nothing left to verify"
              : filter === "failed"
                ? "Nothing has failed"
                : "No items"
          }
          description={
            filter === "open"
              ? "Every item in this batch has a verdict."
              : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((item) => {
            const open = expanded.has(item.id);
            const busy = fb.isLoading(item.id);
            return (
              <li
                key={item.id}
                className={cn("px-4 py-3", item.droppedAt && "opacity-60")}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={item.qaStatus} />
                      {item.prNumber != null ? (
                        <a
                          href={`https://github.com/${repoFullName}/pull/${item.prNumber}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          #{item.prNumber}
                        </a>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          Standing check
                        </Badge>
                      )}
                      <span className="truncate text-sm font-medium">
                        {item.title}
                      </span>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {item.authorLogin ? <span>@{item.authorLogin}</span> : null}
                      {item.mergedAt ? <span>merged {item.mergedAt}</span> : null}
                      {item.linkedIssues.map((n) => (
                        <a
                          key={n}
                          href={`https://github.com/${repoFullName}/issues/${n}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-foreground"
                        >
                          closes #{n}
                        </a>
                      ))}
                      {item.labels.slice(0, 4).map((l) => (
                        <Badge key={l} variant="secondary" className="text-[10px]">
                          {l}
                        </Badge>
                      ))}
                      {item.externalUrl ? (
                        <a
                          href={item.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 hover:text-foreground"
                        >
                          card <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>

                    {item.qaBy ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.qaStatus === "QA_FAILED" ? "Failed" : "Handled"} by{" "}
                        {item.qaBy}
                        {item.qaAt ? ` ${item.qaAt}` : ""}
                        {item.qaNotes ? `: ${item.qaNotes}` : ""}
                      </p>
                    ) : null}

                    {item.summary || item.qaSteps ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                        className="mt-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {open ? (
                          <ChevronDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-3" aria-hidden="true" />
                        )}
                        {item.qaSteps ? "How to test" : "What this is"}
                      </button>
                    ) : null}

                    {open ? (
                      <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-3 text-xs">
                        {item.summary ? (
                          <p className="text-muted-foreground">{item.summary}</p>
                        ) : null}
                        {item.qaSteps ? (
                          <pre className="whitespace-pre-wrap font-sans text-foreground">
                            {item.qaSteps}
                          </pre>
                        ) : (
                          <p className="text-muted-foreground">
                            The author left no testing notes. Add a{" "}
                            <code>## QA</code> section to the PR description to
                            see them here.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>

                  {canVerify && !item.droppedAt ? (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {item.qaStatus === "QA_PENDING" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => apply(item, "QA_IN_REVIEW")}
                        >
                          Claim
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        loading={busy}
                        success={fb.isSuccess(item.id)}
                        disabled={busy || item.qaStatus === "QA_PASSED"}
                        onClick={() => apply(item, "QA_PASSED")}
                      >
                        Pass
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setFailing(failing === item.id ? null : item.id);
                          setNote(item.qaNotes ?? "");
                        }}
                      >
                        Fail
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || item.qaStatus === "QA_SKIPPED"}
                        onClick={() => apply(item, "QA_SKIPPED")}
                      >
                        Skip
                      </Button>
                      {item.qaStatus !== "QA_PENDING" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => apply(item, "QA_PENDING")}
                        >
                          Reset
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {failing === item.id ? (
                  <div className="mt-3 space-y-2 rounded-md border border-border p-3">
                    <label
                      htmlFor={`note-${item.id}`}
                      className="block text-xs font-medium"
                    >
                      What went wrong?
                    </label>
                    <p className="text-xs text-muted-foreground">
                      This goes to the release PR and onto the PR that failed, so
                      write it for whoever has to fix it.
                    </p>
                    <Textarea
                      id={`note-${item.id}`}
                      rows={3}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Checkout 500s on an empty cart."
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy || note.trim().length === 0}
                        onClick={() => apply(item, "QA_FAILED", note)}
                      >
                        Mark failed
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setFailing(null);
                          setNote("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
