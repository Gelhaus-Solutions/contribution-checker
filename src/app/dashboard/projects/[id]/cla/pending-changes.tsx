"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Markdown } from "@/components/markdown";
import { approvePendingChange, rejectPendingChange, getClaVersionBody } from "./actions";
import {
  PriorVersionResignList,
  type PriorVersion,
} from "./prior-version-resign-list";

export type PendingItem = {
  id: string;
  kind: "ICLA" | "CCLA";
  sourcePath: string;
  sourceRef: string | null;
  detectedCommitSha: string | null;
  detectedContent: string;
  detectedAt: string; // ISO
  currentVersionId: string | null;
};

function PendingCard({
  projectId,
  item,
  priorVersions,
}: {
  projectId: string;
  item: PendingItem;
  priorVersions: PriorVersion[];
}) {
  const [showBefore, setShowBefore] = useState(false);
  const [before, setBefore] = useState<string | null>(null);

  async function loadBefore() {
    const next = !showBefore;
    setShowBefore(next);
    if (next && before === null && item.currentVersionId) {
      try {
        const res = await getClaVersionBody(projectId, item.currentVersionId);
        setBefore(res.bodyMarkdown);
      } catch {
        setBefore("");
      }
    }
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Badge variant="outline">{item.kind}</Badge>
              Repo file changed
            </CardTitle>
            <CardDescription>
              <span className="font-mono">{item.sourcePath}</span>
              {item.sourceRef ? ` · ${item.sourceRef}` : ""}
              {item.detectedCommitSha
                ? ` · ${item.detectedCommitSha.slice(0, 10)}`
                : ""}
              {" · detected "}
              {item.detectedAt.replace("T", " ").slice(0, 16)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                New content (to publish)
              </span>
            </div>
            <div className="max-h-[24rem] overflow-y-auto rounded-md border border-border bg-background p-3">
              <Markdown source={item.detectedContent} />
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Current published version
              </span>
              {item.currentVersionId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={loadBefore}
                >
                  {showBefore ? "Hide" : "Show"}
                </Button>
              )}
            </div>
            {showBefore && (
              <div className="max-h-[24rem] overflow-y-auto rounded-md border border-border bg-background p-3">
                {before === null ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : before.trim() ? (
                  <Markdown source={before} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No prior content.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <form action={approvePendingChange} className="space-y-3">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="pendingChangeId" value={item.id} />
          <PriorVersionResignList
            versions={priorVersions}
            idPrefix={`pc-${item.id}`}
          />
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="requireResign"
              value="1"
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              <span className="font-medium">
                Require re-sign for all earlier versions
              </span>
              <span className="block text-xs text-muted-foreground">
                Invalidates every prior {item.kind} signature when this version
                publishes.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton size="sm">Approve &amp; publish</SubmitButton>
          </div>
        </form>

        <form
          action={rejectPendingChange}
          className="flex items-center gap-2 border-t border-border pt-3"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="pendingChangeId" value={item.id} />
          <Input
            type="text"
            name="reason"
            placeholder="Reason (optional)"
            className="h-8 w-56 text-xs"
          />
          <SubmitButton variant="outline" size="sm">
            Reject
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function PendingChanges({
  projectId,
  items,
  iclaVersions,
  cclaVersions,
}: {
  projectId: string;
  items: PendingItem[];
  iclaVersions: PriorVersion[];
  cclaVersions: PriorVersion[];
}) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Repo-file changes to review</CardTitle>
        <CardDescription>
          Review mode is on: these tracked CLA files changed on git. Approve to
          publish a new version (choosing whether to require re-sign), or reject
          to keep the current version.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => (
          <PendingCard
            key={item.id}
            projectId={projectId}
            item={item}
            priorVersions={item.kind === "ICLA" ? iclaVersions : cclaVersions}
          />
        ))}
      </CardContent>
    </Card>
  );
}
