import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Styled native checkbox. Stays native rather than becoming a Radix control
 * because all 33 call sites are inside `<form action={serverAction}>` and rely
 * on the browser serializing the input; a Radix checkbox submits nothing on its
 * own. `accent-color` gets us the cobalt fill without rebuilding the control.
 */
export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    className={cn(
      "size-3.5 shrink-0 rounded-sm border-input accent-primary",
      "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";

/**
 * The checkbox-plus-label-plus-help-text block, which appears verbatim in the
 * settings and quality pages five and more times each.
 */
export function CheckboxField({
  name,
  label,
  description,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <label className={cn("flex items-start gap-2.5 text-sm", className)}>
      <Checkbox name={name} className="mt-0.5" {...props} />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
