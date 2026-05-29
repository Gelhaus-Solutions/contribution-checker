"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FormRenderer } from "@/components/form-renderer";
import { SignatureInput } from "@/components/signature-input";
import { CLA_CUSTOM_FIELD_PREFIX } from "@/lib/cla/schema";
import type { FormSchema } from "@/lib/applications/schema";
import type { ClaActionState } from "../actions";

// `signCcla` returns the shared `ClaActionState`; on success the page
// revalidates and re-renders into the roster manager, so the form only needs
// to surface errors.
const INITIAL: ClaActionState = { status: "idle" };

export function SignCclaForm({
  projectId,
  customFields = [],
  action,
}: {
  projectId: string;
  customFields?: FormSchema;
  action: (
    prev: ClaActionState,
    formData: FormData
  ) => Promise<ClaActionState>;
}) {
  const [state, dispatch, pending] = useActionState<ClaActionState, FormData>(
    action,
    INITIAL
  );
  const [agreed, setAgreed] = useState(false);

  return (
    <form action={dispatch} className="space-y-4">
      <input type="hidden" name="projectId" value={projectId} />

      <fieldset className="space-y-4 rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          Company
        </legend>

        <div className="space-y-1.5">
          <Label htmlFor="companyName">Legal entity (full legal name)</Label>
          <Input
            id="companyName"
            name="companyName"
            required
            autoComplete="organization"
            placeholder="Acme, Inc."
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="registeredAddress">Registered address</Label>
          <Textarea
            id="registeredAddress"
            name="registeredAddress"
            required
            rows={3}
            autoComplete="street-address"
            placeholder="123 Example Street, Suite 100&#10;Springfield, ST 00000"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            name="country"
            required
            autoComplete="country-name"
            placeholder="United States"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="contactName">Point of contact (name)</Label>
          <Input
            id="contactName"
            name="contactName"
            required
            placeholder="Alex Contact"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="contactEmail">Point of contact (email)</Label>
          <Input
            id="contactEmail"
            name="contactEmail"
            type="email"
            required
            autoComplete="email"
            placeholder="legal@acme.com"
          />
          <p className="text-xs text-muted-foreground">
            We&apos;ll notify this address about roster disputes and CLA version
            changes.
          </p>
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          Authorized representative
        </legend>

        <div className="space-y-1.5">
          <Label htmlFor="legalName">Authorized representative (name)</Label>
          <Input
            id="legalName"
            name="legalName"
            required
            autoComplete="name"
            placeholder="Jane Q. Signatory"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="signatoryTitle">Title</Label>
          <Input
            id="signatoryTitle"
            name="signatoryTitle"
            required
            autoComplete="organization-title"
            placeholder="VP of Engineering"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Signature</Label>
          <SignatureInput required />
          <p className="text-xs text-muted-foreground">
            Type, draw, or upload your signature. This constitutes your
            electronic signature binding the company above.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Date: stamped automatically on submission (server time), together with
          your IP address and the exact CLA version you signed.
        </p>
      </fieldset>

      {customFields.length > 0 && (
        <fieldset className="space-y-4 rounded-md border border-border p-4">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            Additional information
          </legend>
          <FormRenderer
            fields={customFields}
            namePrefix={CLA_CUSTOM_FIELD_PREFIX}
          />
        </fieldset>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="agree"
          value="1"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I am authorized to bind the company named above, and I agree to the
          Corporate Contributor License Agreement on its behalf.
        </span>
      </label>

      {state.status === "error" && (
        <p className="text-sm text-destructive">{state.reason}</p>
      )}

      <Button type="submit" loading={pending} disabled={!agreed}>
        Sign corporate CLA
      </Button>
    </form>
  );
}
