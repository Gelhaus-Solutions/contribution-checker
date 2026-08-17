import { cn } from "@/lib/cn";

/**
 * A marketing page section. Separation is a single hairline rule, never a
 * background fill: alternating tinted bands are the thing that makes a page
 * read as a template.
 */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className,
  divider = true,
}: {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  divider?: boolean;
}) {
  return (
    <section
      id={id}
      className={cn(
        "py-12 md:py-16",
        divider && "border-t border-border",
        // Anchored headings should not land under a sticky header.
        id && "scroll-mt-20",
        className,
      )}
    >
      {eyebrow ? (
        <p className="mb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          {eyebrow}
        </p>
      ) : null}
      {title ? (
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h2>
      ) : null}
      {lead ? (
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {lead}
        </p>
      ) : null}
      {children ? <div className={cn(title && "mt-8")}>{children}</div> : null}
    </section>
  );
}

/** A numbered step list. Used for the decision precedence and the how-to lists. */
export function Steps({
  items,
  start = 1,
}: {
  items: React.ReactNode[];
  start?: number;
}) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed">
          <span
            aria-hidden="true"
            className="mt-px w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
          >
            {String(i + start).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** A bordered aside for a caveat that would otherwise get lost in prose. */
export function Note({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed">
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      <div className="text-muted-foreground">{children}</div>
    </aside>
  );
}
