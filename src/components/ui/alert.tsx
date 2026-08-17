import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Tonal notice block. Replaces the ad-hoc
 * `rounded-md border border-success/40 bg-success/10 p-4 text-sm` recipe and
 * the bare `<p className="text-sm text-destructive">` error lines that were
 * copy-pasted across the app.
 *
 * Uses the -strong label tokens for the same reason Badge does: the base
 * semantic colors do not clear WCAG AA on a tint of themselves.
 */
const alertVariants = cva(
  "relative flex w-full gap-2.5 rounded-md border px-3 py-2.5 text-sm",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/50 text-foreground",
        info: "border-primary/25 bg-primary/8 text-primary-strong",
        success: "border-success/25 bg-success/10 text-success-strong",
        warning: "border-warning/30 bg-warning/12 text-warning-strong",
        destructive:
          "border-destructive/25 bg-destructive/8 text-destructive-strong",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const ICONS: Record<string, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
};

export interface AlertProps
  // `title` is widened to ReactNode, so the string-only HTML attribute of the
  // same name has to be dropped first.
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alertVariants> {
  title?: React.ReactNode;
  /** Pass false to drop the leading glyph. */
  icon?: boolean;
}

export function Alert({
  className,
  variant,
  title,
  icon = true,
  children,
  ...props
}: AlertProps) {
  const Icon = variant ? ICONS[variant] : undefined;
  return (
    <div
      // `alert` is for things the user must notice now; a passive success or
      // info panel announcing itself mid-read is worse than silence.
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon && Icon ? (
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? (
          <div className="[&_a]:underline [&_a]:underline-offset-2 [&_p]:leading-relaxed">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
