"use client";

import * as React from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { submitReviewAction } from "../actions";

export type DraftComment = {
  id: string;
  fieldId: string | null;
  fieldLabel: string | null;
  bodyPreview: string;
};

/**
 * Reviewer's pending review composer. State picker decides visibility:
 *   - Approve            → INTERNAL (LGTM)
 *   - Request changes    → APPLICANT (visible + repliable)
 *   - Comment            → reviewer chooses (default INTERNAL)
 *
 * Lists the reviewer's own draft per-field comments with checkboxes; only
 * ticked drafts are linked to the submitted review (others stay drafts).
 */
export function ReviewComposer({
  projectId,
  appId,
  drafts,
}: {
  projectId: string;
  appId: string;
  drafts: DraftComment[];
}) {
  const [state, setState] = React.useState<
    "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
  >("COMMENTED");

  const visibility =
    state === "APPROVED"
      ? "INTERNAL (LGTM)"
      : state === "CHANGES_REQUESTED"
        ? "APPLICANT (visible + repliable)"
        : "your choice";

  return (
    <form action={submitReviewAction} className="space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="appId" value={appId} />

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Review state</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="state"
            value="COMMENTED"
            checked={state === "COMMENTED"}
            onChange={() => setState("COMMENTED")}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Comment</span>
            <span className="ml-1 text-xs text-muted-foreground">
              — leave feedback without a verdict
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="state"
            value="APPROVED"
            checked={state === "APPROVED"}
            onChange={() => setState("APPROVED")}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Approve</span>
            <span className="ml-1 text-xs text-muted-foreground">
              — LGTM, internal signal toward the approval gate
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="state"
            value="CHANGES_REQUESTED"
            checked={state === "CHANGES_REQUESTED"}
            onChange={() => setState("CHANGES_REQUESTED")}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Request changes</span>
            <span className="ml-1 text-xs text-muted-foreground">
              — applicant sees the feedback and may reply to clarify
            </span>
          </span>
        </label>
      </fieldset>

      <div>
        <Label htmlFor="review-body" className="text-xs">
          Summary (markdown supported)
        </Label>
        <Textarea
          id="review-body"
          name="body"
          rows={3}
          placeholder={
            state === "CHANGES_REQUESTED"
              ? "Tell the applicant what to clarify…"
              : "Optional summary…"
          }
        />
      </div>

      {state === "COMMENTED" && (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            name="visibility"
            value="APPLICANT"
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Make this comment visible to the applicant</span>
            <span className="ml-1 text-muted-foreground">
              — otherwise it stays internal to project members.
            </span>
          </span>
        </label>
      )}

      {drafts.length > 0 && (
        <div className="rounded-md border border-border bg-muted/20 p-2">
          <div className="mb-2 text-xs font-medium">
            Attach your draft comments ({drafts.length})
          </div>
          <ul className="space-y-1.5">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  name="draftCommentIds"
                  value={d.id}
                  defaultChecked
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {d.fieldLabel ?? d.fieldId ?? "(general)"}
                  </span>
                  <span className="ml-2 break-words">{d.bodyPreview}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Visibility is normalized from the review state on submit.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Visibility:{" "}
          <Badge variant="secondary" className="ml-1 text-[10px]">
            {visibility}
          </Badge>
        </span>
        <SubmitButton variant="outline">Submit review</SubmitButton>
      </div>
    </form>
  );
}
