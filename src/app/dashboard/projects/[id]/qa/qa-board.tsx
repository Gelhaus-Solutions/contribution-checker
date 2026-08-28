"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import { Markdown } from "@/components/markdown";
import { EmptyState } from "@/components/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionFeedback } from "@/components/ui/use-action-feedback";
import { cn } from "@/lib/cn";
import type { QaStatus } from "@/lib/qa/types";
import { setQaStatus, toggleQaStep, generateAiQaSteps } from "./actions";
import { parseTaskLines, taskProgress } from "@/lib/qa/tasks";

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
  /**
   * Model-suggested steps, shown only when the author wrote none. Kept separate
   * from `qaSteps` on purpose: these do not exist in the PR description, so they
   * must never reach the checkbox editor, which matches on text that is really
   * there.
   */
  aiSteps: AiStepsView | null;
};

export type AiStepsView = {
  summary: string;
  steps: string[];
  unknowns: string[];
  modelId: string | null;
  generatedAt: string;
};

type Filter = "open" | "all" | "failed";

/** A verdict the reviewer has asked for but not yet confirmed. */
type Pending = { item: QaBoardItem; status: QaStatus };

const VERB: Record<string, string> = {
  QA_PASSED: "Mark as passed",
  QA_FAILED: "Mark as failed",
  QA_SKIPPED: "Skip",
  QA_PENDING: "Reset to not verified",
  QA_IN_REVIEW: "Claim",
};

/**
 * The board. Verdicts are per-row and immediate, so this calls the server
 * actions directly through `useActionFeedback` rather than wrapping every row
 * in a form: a checklist needing a page navigation per tick would not get used
 * on a thirty-item batch.
 *
 * Every verdict is confirmed before it is sent. These rows sit next to each
 * other and the buttons are small, so a misclick is the likely error, and the
 * consequence of one is a release that claims somebody verified something they
 * never opened.
 */
export function QaBoard({
  projectId,
  items,
  repoFullName,
  canVerify,
  aiStepsEnabled,
}: {
  projectId: string;
  items: QaBoardItem[];
  repoFullName: string;
  canVerify: boolean;
  aiStepsEnabled: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [detail, setDetail] = useState<QaBoardItem | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
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

  function ask(item: QaBoardItem, status: QaStatus) {
    setError(null);
    setNote(status === "QA_FAILED" ? (item.qaNotes ?? "") : "");
    setPending({ item, status });
  }

  async function confirm() {
    if (!pending) return;
    const { item, status } = pending;
    setError(null);
    try {
      await fb.run(item.id, () =>
        setQaStatus({
          projectId,
          itemIds: [item.id],
          status,
          notes: note.trim() || undefined,
        }),
      );
      setPending(null);
      setNote("");
      setDetail(null);
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

      {error && !detail ? (
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
          {visible.map((item) => (
            <li
              key={item.id}
              className={cn("px-4 py-3", item.droppedAt && "opacity-60")}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setDetail(item)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={item.qaStatus} />
                    {item.prNumber != null ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        #{item.prNumber}
                      </span>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        Standing check
                      </Badge>
                    )}
                    <span className="truncate text-sm font-medium hover:text-primary">
                      {item.title}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {item.authorLogin ? <span>@{item.authorLogin}</span> : null}
                    {item.mergedAt ? <span>merged {item.mergedAt}</span> : null}
                    <StepBadge steps={item.qaSteps} />
                    {item.linkedIssues.length > 0 ? (
                      <span>closes #{item.linkedIssues.join(", #")}</span>
                    ) : null}
                  </span>
                  {item.qaBy ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {item.qaStatus === "QA_FAILED" ? "Failed" : "Handled"} by{" "}
                      {item.qaBy}
                      {item.qaAt ? ` ${item.qaAt}` : ""}
                      {item.qaNotes ? `: ${item.qaNotes}` : ""}
                    </span>
                  ) : null}
                </button>

                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDetail(item)}
                  >
                    Details
                  </Button>
                  {canVerify && !item.droppedAt ? (
                    <Actions
                      item={item}
                      busy={fb.isLoading(item.id)}
                      onPick={ask}
                    />
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {detail ? (
        <DetailDialog
          projectId={projectId}
          item={detail}
          repoFullName={repoFullName}
          canVerify={canVerify && !detail.droppedAt}
          aiStepsEnabled={aiStepsEnabled}
          busy={fb.isLoading(detail.id)}
          error={error}
          onPick={ask}
          onClose={() => {
            setDetail(null);
            setError(null);
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          pending={pending}
          note={note}
          setNote={setNote}
          busy={fb.isLoading(pending.item.id)}
          error={error}
          onConfirm={confirm}
          onCancel={() => {
            setPending(null);
            setNote("");
            setError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function Actions({
  item,
  busy,
  onPick,
}: {
  item: QaBoardItem;
  busy: boolean;
  onPick: (item: QaBoardItem, status: QaStatus) => void;
}) {
  return (
    <>
      {item.qaStatus === "QA_PENDING" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onPick(item, "QA_IN_REVIEW")}
        >
          Claim
        </Button>
      ) : null}
      <Button
        size="sm"
        disabled={busy || item.qaStatus === "QA_PASSED"}
        onClick={() => onPick(item, "QA_PASSED")}
      >
        Pass
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onPick(item, "QA_FAILED")}
      >
        Fail
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || item.qaStatus === "QA_SKIPPED"}
        onClick={() => onPick(item, "QA_SKIPPED")}
      >
        Skip
      </Button>
      {item.qaStatus !== "QA_PENDING" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onPick(item, "QA_PENDING")}
        >
          Reset
        </Button>
      ) : null}
    </>
  );
}

/** Everything known about one item, so a reviewer does not have to open GitHub
 * to find out what they are being asked to verify. */
function DetailDialog({
  projectId,
  item,
  repoFullName,
  canVerify,
  aiStepsEnabled,
  busy,
  error,
  onPick,
  onClose,
}: {
  projectId: string;
  item: QaBoardItem;
  repoFullName: string;
  canVerify: boolean;
  aiStepsEnabled: boolean;
  busy: boolean;
  error: string | null;
  onPick: (item: QaBoardItem, status: QaStatus) => void;
  onClose: () => void;
}) {
  const prUrl =
    item.prNumber != null
      ? `https://github.com/${repoFullName}/pull/${item.prNumber}`
      : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width="xl">
        <DialogHeader>
          <DialogTitle>
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={item.qaStatus} />
              {item.prNumber != null ? (
                <span className="font-mono text-sm text-muted-foreground">
                  #{item.prNumber}
                </span>
              ) : null}
              <span>{item.title}</span>
            </span>
          </DialogTitle>
          <DialogDescription>
            {item.authorLogin ? `by @${item.authorLogin}` : "Standing check"}
            {item.mergedAt ? ` · merged ${item.mergedAt}` : ""}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {item.droppedAt ? (
            <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              This is no longer part of the batch: its merge reached the default
              branch by another route on {item.droppedAt}. The verdict is kept
              for the record.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Open the PR
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
            {item.externalUrl ? (
              <a
                href={item.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Open the card
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
            {item.linkedIssues.map((n) => (
              <a
                key={n}
                href={`https://github.com/${repoFullName}/issues/${n}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                closes #{n}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ))}
          </div>

          {item.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {item.labels.map((l) => (
                <Badge key={l} variant="secondary" className="text-[10px]">
                  {l}
                </Badge>
              ))}
            </div>
          ) : null}

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              What this is
            </h3>
            <p className="text-sm">
              {item.summary ?? (
                <span className="text-muted-foreground">
                  The PR description had no summary paragraph.
                </span>
              )}
            </p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              How to test
            </h3>
            {item.qaSteps ? (
              <QaSteps
                projectId={projectId}
                item={item}
                canVerify={canVerify}
              />
            ) : (
              <AiStepsPanel
                projectId={projectId}
                item={item}
                canGenerate={canVerify && aiStepsEnabled}
              />
            )}
          </section>

          {item.qaBy ? (
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Verdict
              </h3>
              <p className="text-sm">
                {item.qaStatus === "QA_FAILED" ? "Failed" : "Handled"} by{" "}
                {item.qaBy}
                {item.qaAt ? ` ${item.qaAt}` : ""}
                {item.qaNotes ? `: ${item.qaNotes}` : ""}
              </p>
            </section>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive-strong">{error}</p>
          ) : null}

          {canVerify ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border pt-4">
              <Actions item={item} busy={busy} onPick={onPick} />
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm before the verdict is sent.
 *
 * A failure additionally requires a reason, because the note is what reaches
 * the release PR and the PR that failed. The server enforces the same rule, so
 * this is a courtesy rather than the guard.
 */
function ConfirmDialog({
  pending,
  note,
  setNote,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { item, status } = pending;
  const failing = status === "QA_FAILED";
  const name =
    item.prNumber != null ? `#${item.prNumber} ${item.title}` : item.title;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>{VERB[status] ?? "Update"}</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {failing ? (
            <>
              <label
                htmlFor="qa-confirm-note"
                className="block text-sm font-medium"
              >
                What went wrong?
              </label>
              <p className="text-xs text-muted-foreground">
                This goes onto the release PR and onto the PR that failed, so
                write it for whoever has to fix it.
              </p>
              <Textarea
                id="qa-confirm-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Checkout 500s on an empty cart."
                autoFocus
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status === "QA_PASSED"
                ? "This counts toward the release gate: once everything is resolved and nothing failed, the batch is clear to ship."
                : status === "QA_SKIPPED"
                  ? "Skipping counts as resolved. Use it when there is genuinely nothing to verify, not when nobody has got to it yet."
                  : status === "QA_PENDING"
                    ? "This clears the existing verdict and who recorded it."
                    : "You are marking yourself as the person verifying this."}
            </p>
          )}

          {error ? (
            <p className="text-sm text-destructive-strong">{error}</p>
          ) : null}

          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant={failing ? "destructive" : "default"}
              loading={busy}
              disabled={busy || (failing && note.trim().length === 0)}
              onClick={onConfirm}
            >
              {VERB[status] ?? "Confirm"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** How long after the last tick before the batch is written to GitHub. Long
 * enough to absorb somebody working down a checklist, short enough that a
 * closed laptop rarely beats it. */
const FLUSH_DELAY_MS = 7500;

/**
 * The author's QA steps, interactive when they wrote them as a task list.
 *
 * Ticks are held in the browser and flushed as one batch, on a timer or when
 * the dialog closes. The alternative, a round trip per click, makes the
 * checkbox lag behind the pointer and writes one edit to the PR's timeline per
 * box, which on a five-step checklist is five notifications for one reviewer
 * doing one thing.
 *
 * The PR body remains the only stored state. There is no local copy to
 * reconcile: what is held here is a short-lived set of pending changes, and if
 * a flush fails the next reconcile re-derives the truth from GitHub.
 */
function QaSteps({
  projectId,
  item,
  canVerify,
}: {
  projectId: string;
  item: QaBoardItem;
  canVerify: boolean;
}) {
  const [steps, setSteps] = useState(item.qaSteps ?? "");
  const [pending, setPending] = useState<Map<number, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = useMemo(() => parseTaskLines(steps), [steps]);

  // The list as the reviewer sees it: stored state with their unsaved ticks
  // laid over the top.
  const shown = useMemo(
    () => tasks.map((t) => ({ ...t, checked: pending.get(t.index) ?? t.checked })),
    [tasks, pending],
  );
  const progress = useMemo(() => taskProgress(shown), [shown]);

  // Held in a ref as well as state so the flush can run from a timer or from
  // unmount, neither of which sees the latest render's closure.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const changes = [...pendingRef.current.entries()]
      .map(([index, checked]) => {
        const task = tasksRef.current.find((t) => t.index === index);
        return task ? { index, expectedText: task.text, checked } : null;
      })
      .filter((c): c is { index: number; expectedText: string; checked: boolean } => c != null);
    if (changes.length === 0) return;

    setSaving(true);
    try {
      const result = await toggleQaStep({ projectId, itemId: item.id, changes });
      if (result.ok) {
        setPending(new Map());
        if (result.steps != null) setSteps(result.steps);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save those steps.");
    } finally {
      setSaving(false);
    }
  }, [projectId, item.id]);

  // Closing the dialog unmounts this, which is every way out of it: the close
  // button, Escape and clicking away. Flushing here is what makes "save on
  // close" cover all three rather than just the one with a handler on it.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  function toggle(index: number, checked: boolean) {
    setError(null);
    setPending((prev) => {
      const next = new Map(prev);
      const original = tasksRef.current.find((t) => t.index === index);
      // Ticking back to where it started is not a change to write.
      if (original && original.checked === checked) next.delete(index);
      else next.set(index, checked);
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flushRef.current(), FLUSH_DELAY_MS);
  }

  // No task list: the author wrote prose or a numbered list, so render it as
  // the markdown it is and leave it alone.
  if (tasks.length === 0) {
    return <Markdown source={steps} className="rounded-md bg-muted/40 p-3" />;
  }

  const unsaved = pending.size > 0;

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {progress.done} of {progress.total} steps done.
        </span>
        {saving ? (
          <span>Saving to the PR...</span>
        ) : unsaved ? (
          <span className="text-warning-strong">
            Unsaved. Written to the PR when you close this.
          </span>
        ) : (
          <span>Ticking a box updates the PR description.</span>
        )}
      </p>
      <ul className="space-y-1.5 rounded-md bg-muted/40 p-3">
        {shown.map((task) => (
          <li key={`${task.index}:${task.text}`}>
            <label
              className={cn(
                "flex items-start gap-2 text-sm",
                canVerify ? "cursor-pointer" : "cursor-default",
              )}
            >
              <input
                type="checkbox"
                checked={task.checked}
                disabled={!canVerify}
                onChange={(e) => toggle(task.index, e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
              />
              <span
                className={cn(
                  task.checked && "text-muted-foreground line-through",
                  pending.has(task.index) && "italic",
                )}
              >
                {task.text}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="text-xs text-destructive-strong">{error}</p>
      ) : null}
    </div>
  );
}

/** Step progress at a glance, so the list answers "how far in is this?"
 * without opening every item. */
function StepBadge({ steps }: { steps: string | null }) {
  const progress = useMemo(() => taskProgress(parseTaskLines(steps)), [steps]);
  if (progress.total === 0) {
    return steps ? (
      <Badge variant="secondary" className="text-[10px]">
        has QA steps
      </Badge>
    ) : null;
  }
  const done = progress.done === progress.total;
  return (
    <Badge
      variant={done ? "success" : "secondary"}
      className="text-[10px]"
    >
      {progress.done}/{progress.total} steps
    </Badge>
  );
}

/**
 * Suggested steps, or the offer to generate them.
 *
 * Rendered only where the author wrote nothing, and always labelled as
 * generated. The visual separation from real QA steps is the point: a reviewer
 * ticking boxes against a human-written test plan and a reviewer reading a
 * model's guess are doing different things, and the interface should not let
 * those feel the same.
 *
 * Note there is no checkbox here, deliberately. Real steps render through
 * <QaSteps>, whose ticks rewrite the PR description on GitHub. These do not
 * exist in that description, so there is nothing to tick and nowhere to write.
 */
function AiStepsPanel({
  projectId,
  item,
  canGenerate,
}: {
  projectId: string;
  item: QaBoardItem;
  canGenerate: boolean;
}) {
  const ai = item.aiSteps;

  if (!ai) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          The author left no testing notes. Add a <code>## QA</code> section to
          the PR description and they appear here.
        </p>
        {canGenerate ? (
          <form action={generateAiQaSteps}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={item.id} />
            <SubmitButton variant="outline" size="sm">
              Suggest steps with AI
            </SubmitButton>
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">AI suggested</Badge>
        {canGenerate ? (
          <form action={generateAiQaSteps}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="force" value="1" />
            <SubmitButton variant="ghost" size="sm">
              Regenerate
            </SubmitButton>
          </form>
        ) : null}
      </div>
      <p className="text-sm">{ai.summary}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {ai.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {ai.unknowns.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Could not determine
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {ai.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Generated by a model from the PR description and its changed files, not
        written by the author. Check it before you rely on it.
      </p>
    </div>
  );
}
