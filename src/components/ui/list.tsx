import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The divide-y row list, extracted. This shape appears 24 times across the app
 * with the padding retyped each time, usually as `px-6 py-3` to line up with a
 * card's own padding.
 *
 * For genuinely tabular data (aligned columns, numbers) reach for ui/table
 * instead. This is for rich rows whose internal layout varies.
 */
export function List({
  className,
  ...props
}: React.HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      className={cn("divide-y divide-border", className)}
      {...props}
    />
  );
}

const ROW =
  "flex items-center justify-between gap-3 px-6 py-2.5 text-sm transition-colors";

export function ListRow({
  className,
  ...props
}: React.LiHTMLAttributes<HTMLLIElement>) {
  return <li className={cn(ROW, className)} {...props} />;
}

/**
 * A row that is entirely a link. Kept separate because the <li> has to stay
 * padding-free for the anchor to fill it, which is the detail every hand-rolled
 * copy of this pattern gets slightly differently.
 */
export function ListLinkRow({
  href,
  className,
  children,
  ...props
}: { href: string } & Omit<React.ComponentProps<typeof Link>, "href">) {
  return (
    <li>
      <Link href={href} className={cn(ROW, "hover:bg-muted/50", className)} {...props}>
        {children}
      </Link>
    </li>
  );
}
