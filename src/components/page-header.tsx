import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The page heading block. Twelve pages hand-rolled this, in three different
 * recipes: `text-2xl font-semibold` in the dashboard and admin, `text-3xl
 * font-bold tracking-tight` on the public pages, and `text-xl font-semibold`
 * in the project shell.
 */
export function PageHeader({
  title,
  description,
  back,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Breadcrumb link above the title. */
  back?: { href: string; label: string };
  /** Right-aligned actions, aligned to the title's baseline. */
  actions?: React.ReactNode;
  /** Badges or mono detail rendered under the title. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 space-y-1.5", className)}>
      {back ? (
        <Link
          href={back.href}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          {meta ? (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
