import * as React from "react";
import { cn } from "@/lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // bg-background rather than bg-card: on a card the field reads as
        // recessed, which is what tells you it is an input before you click it.
        "flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-sm shadow-xs transition-colors",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
