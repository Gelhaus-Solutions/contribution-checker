import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Loading placeholder. Replaces the six inline `Loading…` paragraphs, which
 * collapse the layout while data is in flight and then shove it back open.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

/** Stand-in for a divide-y list that has not loaded yet. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-6 py-3">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
