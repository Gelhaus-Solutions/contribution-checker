"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { formatDateTime } from "@/lib/ui/format";
import { getClaVersionBody, setVersionResign } from "./actions";

export type HistoryVersion = {
  id: string;
  kind: string;
  version: number;
  contentHash: string;
  sourceType: string;
  sourcePath: string | null;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  resignRequired: boolean;
  isCurrent: boolean;
  publishedAt: string; // ISO
  repoFullName: string | null;
};

function blobUrl(v: HistoryVersion): string | null {
  if (v.sourceType !== "repo_file" || !v.repoFullName || !v.sourcePath) {
    return null;
  }
  const ref = v.sourceCommitSha ?? v.sourceRef ?? "HEAD";
  return `https://github.com/${v.repoFullName}/blob/${ref}/${v.sourcePath}`;
}

function Row({ projectId, v }: { projectId: string; v: HistoryVersion }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && body === null && !loading) {
      setLoading(true);
      try {
        const res = await getClaVersionBody(projectId, v.id);
        setBody(res.bodyMarkdown);
      } catch {
        setBody("");
        setError("Could not load this version's content.");
      } finally {
        setLoading(false);
      }
    }
  }

  function onSetResign(resignRequired: boolean) {
    setError(null);
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("versionId", v.id);
    fd.set("resignRequired", resignRequired ? "1" : "0");
    startTransition(async () => {
      try {
        await setVersionResign(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update re-sign.");
      }
    });
  }

  const blob = blobUrl(v);
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-wrap items-center gap-2 text-left"
        >
          <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
          <Badge variant="outline">{v.kind}</Badge>
          <span className="font-medium">v{v.version}</span>
          <span className="font-mono text-muted-foreground">
            {v.contentHash.slice(0, 12)}
          </span>
          <span className="text-muted-foreground">{v.sourceType}</span>
          {v.resignRequired && <Badge variant="warning">requires re-sign</Badge>}
          {v.isCurrent && <Badge variant="success">current</Badge>}
        </button>
        <span className="text-muted-foreground">
          {formatDateTime(v.publishedAt)}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
            {blob && (
              <a
                href={blob}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                View on GitHub
              </a>
            )}
            {v.sourceCommitSha && (
              <span className="font-mono">
                commit {v.sourceCommitSha.slice(0, 10)}
              </span>
            )}
            {/* The current version is always valid and cannot be marked stale. */}
            {!v.isCurrent &&
              (v.resignRequired ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={pending}
                  onClick={() => onSetResign(false)}
                >
                  Mark valid again
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={pending}
                  onClick={() => onSetResign(true)}
                >
                  Require re-sign
                </Button>
              ))}
          </div>

          {error && <p className="text-destructive">{error}</p>}

          <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border bg-background p-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : body && body.trim() ? (
              <Markdown source={body} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {body === "" ? "No content." : "Nothing to preview."}
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function VersionHistory({
  projectId,
  versions,
}: {
  projectId: string;
  versions: HistoryVersion[];
}) {
  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No versions have been published yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {versions.map((v) => (
        <Row key={v.id} projectId={projectId} v={v} />
      ))}
    </ul>
  );
}
