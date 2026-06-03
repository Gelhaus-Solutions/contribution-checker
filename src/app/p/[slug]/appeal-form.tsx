"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormRenderer, type FormValue } from "@/components/form-renderer";
import type { FormSchema } from "@/lib/applications/schema";

type FormValues = Record<string, FormValue>;

export type AppealState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; reason: string; values?: FormValues; message?: string };

/**
 * Appeal a denied application: a free-text message plus a chance to revise the
 * original answers (pre-filled from the existing application). Mirrors
 * ApplyForm; revised answers are validated server-side against the current
 * form schema.
 */
export function AppealForm({
  applicationId,
  fields,
  initialValues,
  initialMessage,
  action,
}: {
  applicationId: string;
  fields: FormSchema;
  initialValues: FormValues;
  initialMessage?: string;
  action: (prev: AppealState, formData: FormData) => Promise<AppealState>;
}) {
  const [state, dispatch, pending] = useActionState<AppealState, FormData>(
    action,
    { status: "idle" },
  );

  const [values, setValues] = useState<FormValues>(initialValues);
  const setValue = (id: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  };

  // Re-populate from the echoed values after a server validation error so the
  // applicant does not lose their edits (mirrors ApplyForm).
  const lastEchoedRef = useRef<AppealState | null>(null);
  useEffect(() => {
    if (state === lastEchoedRef.current) return;
    lastEchoedRef.current = state;
    if (state.status === "error" && state.values) {
      setValues((prev) => ({ ...prev, ...state.values }));
    }
  }, [state]);

  if (state.status === "ok") {
    return (
      <div className="rounded-md border border-success/40 bg-success/10 p-4 text-sm">
        Your appeal was submitted. The project&apos;s reviewers will be notified.
      </div>
    );
  }

  const defaultMessage =
    state.status === "error" ? (state.message ?? "") : (initialMessage ?? "");

  return (
    <form action={dispatch} className="space-y-5">
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="space-y-1">
        <Label htmlFor="appeal-message">Why should this be reconsidered?</Label>
        <Textarea
          id="appeal-message"
          name="message"
          rows={4}
          required
          defaultValue={defaultMessage}
          placeholder="Explain why you believe the decision should be reconsidered."
        />
      </div>
      {fields.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            You can also update your answers below.
          </p>
          <FormRenderer fields={fields} values={values} onChange={setValue} />
        </div>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}
      <Button type="submit" loading={pending}>
        Submit appeal
      </Button>
    </form>
  );
}
