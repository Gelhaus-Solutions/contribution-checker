"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ClaActionState } from "../actions";

// `signCcla` returns the shared `ClaActionState`; on success the page
// revalidates and re-renders into the roster manager, so the form only needs
// to surface errors.
const INITIAL: ClaActionState = { status: "idle" };

export function SignCclaForm({
  projectId,
  action,
}: {
  projectId: string;
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

      <div className="space-y-1.5">
        <Label htmlFor="companyName">Company legal name</Label>
        <Input
          id="companyName"
          name="companyName"
          required
          autoComplete="organization"
          placeholder="Acme, Inc."
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="signatoryTitle">Your title (optional)</Label>
        <Input
          id="signatoryTitle"
          name="signatoryTitle"
          autoComplete="organization-title"
          placeholder="VP of Engineering"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="contactEmail">Contact email</Label>
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

      <div className="space-y-1.5">
        <Label htmlFor="legalName">Your full legal name</Label>
        <Input
          id="legalName"
          name="legalName"
          required
          autoComplete="name"
          placeholder="Jane Q. Signatory"
        />
        <p className="text-xs text-muted-foreground">
          Typing your name acts as your signature on behalf of the company.
        </p>
      </div>

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
