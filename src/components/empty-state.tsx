import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The "nothing here" block. Around 15 sites wrote this by hand in three
 * different shapes, and eight of them repeated the same
 * `q ? "No X match your search." : "No X yet."` ternary.
 *
 * Pass `query` to get the searched variant, which also offers a way back to
 * the unfiltered list. That link is the part every hand-rolled copy omitted.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  query,
  clearHref,
  variant = "panel",
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** The active search term, if the list is filtered. */
  query?: string;
  /** Where "Clear search" should point. */
  clearHref?: string;
  /** `row` sits inside a divide-y list; `panel` fills a card body. */
  variant?: "row" | "panel";
  className?: string;
}) {
  const searching = Boolean(query);

  return (
    <div
      className={cn(
        "text-center",
        variant === "panel"
          ? "flex flex-col items-center gap-2 px-6 py-12"
          : "flex flex-col items-center gap-1.5 px-6 py-8",
        className,
      )}
    >
      {Icon && variant === "panel" ? (
        <div className="mb-1 flex size-9 items-center justify-center rounded-full border border-border bg-muted/60">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}

      <p className="text-sm font-medium">
        {searching ? `No results for "${query}"` : title}
      </p>

      {searching ? (
        clearHref ? (
          <Link
            href={clearHref}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Clear search
          </Link>
        ) : null
      ) : (
        <>
          {description ? (
            <p className="max-w-sm text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
          {action ? <div className="mt-2">{action}</div> : null}
        </>
      )}
    </div>
  );
}
