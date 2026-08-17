import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

// Tonal rather than solid. At 11px a saturated pill is the loudest thing on a
// dense page, and it fights every other status on screen for attention; a tint
// plus a colored label reads as a state instead of an alert. It also sidesteps
// the contrast problem of white-on-amber, which never passed at this size.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-primary/25 bg-primary/10 text-primary-strong",
        secondary: "border-border bg-muted text-muted-foreground",
        success: "border-success/25 bg-success/12 text-success-strong",
        warning: "border-warning/30 bg-warning/15 text-warning-strong",
        destructive:
          "border-destructive/25 bg-destructive/10 text-destructive-strong",
        outline: "border-border text-muted-foreground",
        /** Solid primary, for the rare badge that has to win the page. */
        solid: "border-transparent bg-primary text-primary-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
