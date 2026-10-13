"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  raiseOneRungAction,
  reportDecoysAction,
  type LockdownActionState,
} from "./actions";

const IDLE: LockdownActionState = { status: "idle" };

function Outcome({ state }: { state: LockdownActionState }) {
  if (state.status === "idle") return null;
  return (
    <Alert variant={state.status === "ok" ? "success" : "destructive"}>{state.message}</Alert>
  );
}

/**
 * Raising this app one rung. Native controls throughout, so it works with
 * scripts off; the reason and the acknowledgement are required by the browser
 * and checked again by the action. `from` is the rung this form was rendered
 * at: the action sends nothing once the stage has moved past it.
 */
export function RaiseForm({
  from,
  to,
  disabled,
}: {
  from: string;
  to: string;
  disabled: boolean;
}) {
  const [state, dispatch] = useActionState(raiseOneRungAction, IDLE);
  return (
    <form action={dispatch} className="space-y-3">
      <input type="hidden" name="from" value={from} />
      <div className="space-y-1.5">
        <Label htmlFor="lockdown-reason">Reason</Label>
        <Textarea
          id="lockdown-reason"
          name="reason"
          required
          minLength={3}
          maxLength={500}
          disabled={disabled}
          placeholder="What you saw, in a line. GLockdown keeps it with the raise."
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox name="understood" required disabled={disabled} className="mt-0.5" />
        <span>
          I understand that nothing in this app can lower the stage again. Only GLockdown can.
        </span>
      </label>
      <SubmitButton variant="destructive" size="sm" disabled={disabled}>
        Raise to {to}
      </SubmitButton>
      <Outcome state={state} />
    </form>
  );
}

/** Tells GLockdown which decoys this app checks, now. */
export function ReportDecoysForm({ disabled }: { disabled: boolean }) {
  const [state, dispatch] = useActionState(reportDecoysAction, IDLE);
  return (
    <form action={dispatch} className="space-y-2">
      <SubmitButton size="sm" variant="outline" disabled={disabled}>
        Report now
      </SubmitButton>
      <Outcome state={state} />
    </form>
  );
}
