"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Markdown } from "@/components/markdown";
import { FormRenderer, type FormValue } from "@/components/form-renderer";
import { SignatureInput } from "@/components/signature-input";
import type { FormSchema } from "@/lib/applications/schema";
import { CLA_CUSTOM_FIELD_PREFIX } from "@/lib/cla/schema";

type FormValues = Record<string, FormValue>;

/**
 * Snapshot of the project's current ICLA version, passed when the apply page
 * determines the signed-in user must sign a CLA inline (embedded placement and
 * not yet covered). The `cla_*` form fields below live in a reserved namespace
 * outside the form schema, so `collectAnswers` never reads them.
 */
export type ClaEmbed = {
  versionId: string;
  contentHash: string;
  bodyMarkdown: string;
  version: number;
  requireSignature: boolean;
  customFields: FormSchema;
};

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
  claEmbed,
}: {
  projectId: string;
  fields: FormSchema;
  action: (prev: ApplyState, formData: FormData) => Promise<ApplyState>;
  claEmbed?: ClaEmbed | null;
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
      {claEmbed && (
        <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
          <div>
            <h3 className="text-sm font-semibold">
              Contributor License Agreement
            </h3>
            <p className="text-xs text-muted-foreground">
              You must accept this agreement (version {claEmbed.version}) to
              submit your application.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-background p-3">
            <Markdown source={claEmbed.bodyMarkdown} />
          </div>
          <input type="hidden" name="cla_versionId" value={claEmbed.versionId} />
          <input
            type="hidden"
            name="cla_contentHash"
            value={claEmbed.contentHash}
          />
          {claEmbed.customFields.length > 0 && (
            <FormRenderer
              fields={claEmbed.customFields}
              namePrefix={CLA_CUSTOM_FIELD_PREFIX}
            />
          )}
          {claEmbed.requireSignature && (
            <>
              <div className="space-y-1">
                <Label htmlFor="cla_legalName">Full legal name</Label>
                <Input
                  id="cla_legalName"
                  name="cla_legalName"
                  required
                  autoComplete="name"
                  placeholder="Your full legal name"
                />
              </div>
              <div className="space-y-1">
                <Label>Signature</Label>
                <SignatureInput fieldPrefix="cla_" required />
                <p className="text-xs text-muted-foreground">
                  Type, draw, or upload your signature.
                </p>
              </div>
            </>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="cla_agree"
              required
              className="mt-0.5"
            />
            <span>
              I have read and agree to the Contributor License Agreement above,
              and I am signing it as the GitHub account I am authenticated with.
            </span>
          </label>
        </div>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}
      {fields.length === 0 && !claEmbed ? (
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
