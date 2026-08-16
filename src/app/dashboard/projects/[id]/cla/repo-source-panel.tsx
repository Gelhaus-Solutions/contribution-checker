"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { fetchClaRepoSource, runClaRepoSync } from "./actions";
import type { RepoSourceView, SyncOutcome } from "@/lib/cla/repo-source";
import { Alert } from "@/components/ui/alert";

function outcomeText(o: SyncOutcome): string {
  switch (o.status) {
    case "unchanged":
      return `${o.kind}: already in sync`;
    case "published":
      return `${o.kind}: published v${o.version}`;
    case "pending":
      return `${o.kind}: change queued for review`;
    case "error":
      return `${o.kind}: ${o.message}`;
  }
}

/**
 * Per repo-file-sourced kind: view the live repo file, compare it to the stored
 * published version (drift badge), link to GitHub, and run a manual sync. Both
 * the live fetch and the sync are on-demand so the page never hits the GitHub
 * contents API just by loading.
 */
export function RepoSourcePanel({
  projectId,
  kind,
  label,
}: {
  projectId: string;
  kind: "ICLA" | "CCLA";
  label: string;
}) {
  const [view, setView] = useState<RepoSourceView | null>(null);
  const [showContent, setShowContent] = useState(false);
  const [loading, startLoad] = useTransition();
  const [syncing, startSync] = useTransition();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadView() {
    setError(null);
    startLoad(async () => {
      try {
        const res = await fetchClaRepoSource(projectId, kind);
        setView(res);
        setShowContent(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the source.");
      }
    });
  }

  function sync() {
    setError(null);
    setSyncMsg(null);
    startSync(async () => {
      try {
        const { results } = await runClaRepoSync(projectId, kind);
        setSyncMsg(
          results.length
            ? results.map(outcomeText).join("; ")
            : "Nothing to sync."
        );
        // Refresh the drift view after a sync.
        const res = await fetchClaRepoSource(projectId, kind);
        setView(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed.");
      }
    });
  }

  const blobUrl =
    view && view.sourced
      ? `https://github.com/${view.fullName}/blob/${view.sourceRef ?? "HEAD"}/${view.sourcePath}`
      : null;

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{label} source</span>
          {view?.sourced && view.available && (
            <Badge variant={view.matchesStored ? "success" : "warning"}>
              {view.matchesStored ? "in sync" : "drifted"}
            </Badge>
          )}
          {view?.sourced === false && (
            <span className="text-xs text-muted-foreground">
              not tracked from a repo file
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={loading}
            onClick={loadView}
          >
            View live source
          </Button>
          <Button
            type="button"
            size="sm"
            loading={syncing}
            onClick={sync}
          >
            Sync now
          </Button>
        </div>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}
      {syncMsg && <p className="text-xs text-muted-foreground">{syncMsg}</p>}

      {view?.sourced && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{view.sourcePath}</span>
            {view.sourceRef && <span>ref: {view.sourceRef}</span>}
            {blobUrl && (
              <a
                href={blobUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                View on GitHub
              </a>
            )}
          </div>
          {!view.available && (
            <p className="text-warning">
              Cannot read the live file (the GitHub App may not be installed).
              Drift cannot be checked.
            </p>
          )}
          {view.sourced && view.available && !view.matchesStored && (
            <p>
              The repo file differs from the published version. Use Sync now to
              publish (or queue) the change.
            </p>
          )}
        </div>
      )}

      {showContent && view?.sourced && view.available && (
        <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border bg-background p-3">
          <Markdown source={view.content} />
        </div>
      )}
    </div>
  );
}
