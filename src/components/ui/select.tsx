import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** `sm` is the 28px filter-bar size, `default` the 32px form size. */
  fieldSize?: "sm" | "default";
}

/**
 * Styled native <select>.
 *
 * Deliberately not Radix. Every call site in this app is either inside a
 * `<form action={serverAction}>`, calls `form.requestSubmit()` on change, or is
 * the public application form that has to work with JS disabled. Radix Select
 * renders a button plus a portal and submits nothing without a mirrored hidden
 * input, which would break all three. Native also gives us the platform picker
 * on mobile and keyboard type-ahead for free.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, fieldSize = "default", children, ...props }, ref) => (
    <div className="relative inline-flex w-full">
      <select
        ref={ref}
        className={cn(
          "w-full appearance-none rounded-md border border-input bg-background text-foreground shadow-xs transition-colors",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          fieldSize === "sm"
            ? "h-7 pr-7 pl-2 text-xs"
            : "h-8 pr-8 pl-2.5 text-sm",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
          fieldSize === "sm" ? "right-2 size-3" : "right-2.5 size-3.5",
        )}
      />
    </div>
  ),
);
Select.displayName = "Select";
