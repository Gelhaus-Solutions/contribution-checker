"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import { FormRenderer } from "@/components/form-renderer";
import { SignatureInput } from "@/components/signature-input";
import { CLA_CUSTOM_FIELD_PREFIX } from "@/lib/cla/schema";
import type { FormSchema } from "@/lib/applications/schema";
import { Alert } from "@/components/ui/alert";
import type { ClaActionState } from "./actions";

/**
 * Standalone ICLA click-wrap form. Renders the immutable CLA text in a
 * scrollable bordered box, a required "I agree" checkbox, a required typed
 * full legal name, and a read-only "Signing as @login" line (the login is
 * server-derived and passed in, never editable). No localStorage: a CLA is a
 * legal act, not a draft, so we never persist partial input.
 */
export function SignForm({
  projectId,
  versionId,
  contentHash,
  bodyMarkdown,
  ghLogin,
  applicationId,
  requireSignature = true,
  customFields = [],
  action,
}: {
  projectId: string;
  versionId: string;
  contentHash: string;
  bodyMarkdown: string;
  ghLogin: string;
  applicationId?: string;
  requireSignature?: boolean;
  customFields?: FormSchema;
  action: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const [state, dispatch, pending] = useActionState<ClaActionState, FormData>(
    action,
    { status: "idle" }
  );

  if (state.status === "ok") {
    return (
      <Alert variant="success">
        Signed. Any PRs blocked pending your CLA will re-check automatically.
      </Alert>
    );
  }

  return (
    <form action={dispatch} className="space-y-4">
      <input type="hidden" name="projectId" value={projectId} />
      {/* versionId/contentHash are hidden context only; the server re-derives
          the authoritative version and never trusts these values. */}
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="contentHash" value={contentHash} />
      {applicationId && (
        <input type="hidden" name="applicationId" value={applicationId} />
      )}

      <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
        <Markdown source={bodyMarkdown} />
      </div>

      <div className="flex items-start gap-2">
        <input
          id="cla-agree"
          name="agree"
          type="checkbox"
          required
          value="1"
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <Label htmlFor="cla-agree" className="leading-snug">
          I have read and agree to be legally bound by this Contributor License
          Agreement.
        </Label>
      </div>

      {customFields.length > 0 && (
        <FormRenderer
          fields={customFields}
          namePrefix={CLA_CUSTOM_FIELD_PREFIX}
        />
      )}

      {/* The signer's full legal name is always collected. */}
      <div className="space-y-1.5">
        <Label htmlFor="cla-legal-name">Full legal name</Label>
        <Input
          id="cla-legal-name"
          name="legalName"
          required
          minLength={2}
          maxLength={200}
          autoComplete="name"
          placeholder="Your full legal name"
        />
      </div>
      {requireSignature && (
        <div className="space-y-1.5">
          <Label>Signature</Label>
          <SignatureInput required />
          <p className="text-xs text-muted-foreground">
            Type, draw, or upload your signature.
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Signing as <span className="font-medium">@{ghLogin}</span>. Your GitHub
        identity, the agreement text, your IP address, and a timestamp are
        recorded as part of this signature.
      </p>

      {state.status === "error" && (
        <Alert variant="destructive">{state.reason}</Alert>
      )}

      <Button type="submit" loading={pending}>
        Sign the CLA
      </Button>
    </form>
  );
}

/**
 * "I'm not affiliated with this organization, request exemption" form shown on
 * the covered-by-corporate state. Files a dispute against the contributor's own
 * roster membership, which immediately suspends coverage and notifies the
 * maintainers and the corporate contact.
 */
export function DisputeForm({
  memberId,
  companyName,
  action,
}: {
  memberId: string;
  companyName: string;
  action: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const [state, dispatch, pending] = useActionState<ClaActionState, FormData>(
    action,
    { status: "idle" }
  );

  if (state.status === "ok") {
    return (
      <Alert variant="warning">
        Your dispute was filed. Your coverage under {companyName} is suspended
        and the maintainers have been notified. You can now sign the CLA
        individually.
      </Alert>
    );
  }

  return (
    <form action={dispatch} className="space-y-3">
      <input type="hidden" name="memberId" value={memberId} />
      <div className="space-y-1.5">
        <Label htmlFor="dispute-note">Reason (optional)</Label>
        <Textarea
          id="dispute-note"
          name="note"
          rows={2}
          maxLength={500}
          placeholder="e.g. I have never worked at this company."
          className="text-sm"
        />
      </div>
      {state.status === "error" && (
        <Alert variant="destructive">{state.reason}</Alert>
      )}
      <Button type="submit" variant="outline" loading={pending}>
        I&apos;m not affiliated, request exemption
      </Button>
    </form>
  );
}
