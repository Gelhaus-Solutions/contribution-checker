"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormRenderer } from "@/components/form-renderer";
import type { FormSchema } from "@/lib/applications/schema";

export type ApplyState =
  | { status: "idle" }
  | { status: "ok"; applicationId: string }
  | { status: "error"; reason: string };

export function ApplyForm({
  projectId,
  fields,
  action,
}: {
  projectId: string;
  fields: FormSchema;
  action: (prev: ApplyState, formData: FormData) => Promise<ApplyState>;
}) {
  const [state, dispatch, pending] = useActionState<ApplyState, FormData>(
    action,
    { status: "idle" }
  );

  if (state.status === "ok") {
    return (
      <div className="rounded-md border border-success/40 bg-success/10 p-4 text-sm">
        Application submitted. You&apos;ll be notified when a project admin
        reviews it.
      </div>
    );
  }

  return (
    <form action={dispatch} className="space-y-5">
      <input type="hidden" name="projectId" value={projectId} />
      <FormRenderer fields={fields} />
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The project owner hasn&apos;t set up the application form yet.
        </p>
      ) : (
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit application"}
        </Button>
      )}
    </form>
  );
}
