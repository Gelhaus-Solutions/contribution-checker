import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  buildPageHref,
  totalPages,
  type PageKeys,
  type SearchParamRecord,
} from "@/lib/pagination";

// Server component (no client JS). Prev/Next are plain links that preserve every
// current query param, so sibling state (status tabs, other paginators) survives.
export function Pagination({
  pathname,
  searchParams,
  page,
  perPage,
  total,
  keys,
  className,
}: {
  pathname: string;
  searchParams: SearchParamRecord;
  page: number;
  perPage: number;
  total: number;
  keys?: Partial<PageKeys>;
  className?: string;
}) {
  if (total <= perPage) return null;

  const pages = totalPages(total, perPage);
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * perPage + 1;
  const end = Math.min(current * perPage, total);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-6 py-3 text-xs text-muted-foreground",
        className
      )}
    >
      {current > 1 ? (
        <Button asChild variant="outline" size="sm">
          <Link href={buildPageHref(pathname, searchParams, current - 1, keys)}>
            Previous
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Previous
        </Button>
      )}
      <span>
        Showing {start} to {end} of {total}
      </span>
      {current < pages ? (
        <Button asChild variant="outline" size="sm">
          <Link href={buildPageHref(pathname, searchParams, current + 1, keys)}>
            Next
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Next
        </Button>
      )}
    </div>
  );
}
