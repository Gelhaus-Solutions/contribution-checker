"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

export interface SubmitButtonProps
  extends Omit<ButtonProps, "type" | "loading" | "success"> {
  successDuration?: number;
}

export function SubmitButton({
  successDuration = 1500,
  disabled,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const [showSuccess, setShowSuccess] = React.useState(false);
  const wasPending = React.useRef(false);

  React.useEffect(() => {
    const justFinished = wasPending.current && !pending;
    wasPending.current = pending;
    if (!justFinished) return;
    setShowSuccess(true);
    const t = setTimeout(() => setShowSuccess(false), successDuration);
    return () => clearTimeout(t);
  }, [pending, successDuration]);

  return (
    <Button
      type="submit"
      loading={pending}
      success={showSuccess}
      disabled={disabled}
      {...props}
    />
  );
}
