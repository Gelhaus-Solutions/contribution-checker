"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormRenderer, type FormValue } from "@/components/form-renderer";
import type { FormSchema } from "@/lib/applications/schema";

type FormValues = Record<string, FormValue>;

export type ApplyState =
  | { status: "idle" }
  | { status: "ok"; applicationId: string }
  | { status: "error"; reason: string; values?: FormValues };

const STORAGE_PREFIX = "contribution-checker:apply:";

function readDraft(key: string): FormValues | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FormValues)
      : null;
  } catch {
    return null;
  }
}

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

  const storageKey = `${STORAGE_PREFIX}${projectId}`;
  const [values, setValues] = useState<FormValues>({});
  const hydratedRef = useRef(false);
  const lastEchoedRef = useRef<ApplyState | null>(null);

  // Hydrate the draft from localStorage so values survive reloads / new tabs.
  useEffect(() => {
    const stored = readDraft(storageKey);
    if (stored) setValues(stored);
    hydratedRef.current = true;
  }, [storageKey]);

  // After a server validation error, re-populate the form from the echoed
  // values so the user does not lose their input on a regex mismatch.
  useEffect(() => {
    if (state === lastEchoedRef.current) return;
    lastEchoedRef.current = state;
    if (state.status === "error" && state.values) {
      setValues((prev) => ({ ...prev, ...state.values }));
    }
  }, [state]);

  // Persist on every change.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(values));
    } catch {
      // quota / private mode — non-fatal
    }
  }, [storageKey, values]);

  // Live-sync across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey || e.newValue == null) return;
      try {
        const next = JSON.parse(e.newValue);
        if (next && typeof next === "object" && !Array.isArray(next)) {
          setValues(next as FormValues);
        }
      } catch {
        // ignore malformed payloads from other tabs
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  // Clear the saved draft once the application is accepted.
  useEffect(() => {
    if (state.status !== "ok") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [state, storageKey]);

  const setValue = (id: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  };

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
      <FormRenderer fields={fields} values={values} onChange={setValue} />
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The project owner hasn&apos;t set up the application form yet.
        </p>
      ) : (
        <Button type="submit" loading={pending}>
          Submit application
        </Button>
      )}
    </form>
  );
}
