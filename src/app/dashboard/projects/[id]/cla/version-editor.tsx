"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Markdown } from "@/components/markdown";
import { publishClaVersion } from "./actions";

type CurrentVersion = {
  version: number;
  contentHash: string;
  sourceType: string;
};

export function VersionEditor({
  projectId,
  kind,
  current,
}: {
  projectId: string;
  kind: "ICLA" | "CCLA";
  current: CurrentVersion | null;
}) {
  const [body, setBody] = useState("");
  const label = kind === "ICLA" ? "Individual CLA" : "Corporate CLA";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {current ? (
          <>
            <Badge variant="success">v{current.version} published</Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {current.contentHash.slice(0, 12)}
            </span>
            <span className="text-xs text-muted-foreground">
              source: {current.sourceType}
            </span>
          </>
        ) : (
          <Badge variant="warning">no version published</Badge>
        )}
      </div>

      <form action={publishClaVersion} className="space-y-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="kind" value={kind} />
        {/* This editor publishes manual text. The Source card controls the
            repo-file alternative for the next publish. */}
        <input type="hidden" name="sourceType" value="manual" />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`body-${kind}`} className="text-xs">
              {label} text (Markdown)
            </Label>
            <Textarea
              id={`body-${kind}`}
              name="bodyMarkdown"
              rows={16}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Paste the ${label} text here…`}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Preview</Label>
            <div className="min-h-[16rem] max-h-[32rem] overflow-y-auto rounded-md border border-border bg-background p-3">
              {body.trim() ? (
                <Markdown source={body} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing to preview yet.
                </p>
              )}
            </div>
          </div>
        </div>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="requireResign"
            value="1"
            className="mt-0.5 h-4 w-4 rounded border-border"
          />
          <span>
            <span className="font-medium">Require re-sign</span>
            <span className="block text-xs text-muted-foreground">
              Invalidates all prior {kind} signatures &mdash; everyone must sign
              this new version before their PRs pass again. Leave off to keep
              existing signatures valid.
            </span>
          </span>
        </label>

        <SubmitButton disabled={!body.trim()}>
          Publish {current ? `v${current.version + 1}` : "v1"}
        </SubmitButton>
      </form>
    </div>
  );
}
