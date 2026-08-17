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
        "py-9 md:py-12",
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
        <h2 className="text-xl font-semibold tracking-tight text-balance md:text-2xl">
          {title}
        </h2>
      ) : null}
      {lead ? (
        <p className="mt-2.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {lead}
        </p>
      ) : null}
      {children ? <div className={cn(title && "mt-6")}>{children}</div> : null}
    </section>
  );
}

/**
 * A numbered step list.
 *
 * The numbers hang into the container's left padding rather than pushing the
 * text across, so a step's body starts on exactly the same vertical line as
 * the section heading and lead above it. Indenting the text instead (the
 * obvious `flex gap-3` version) put every step 32px out of line with the rest
 * of the page.
 */
export function Steps({
  items,
  start = 1,
}: {
  items: React.ReactNode[];
  start?: number;
}) {
  return (
    <ol className="space-y-3.5">
      {items.map((item, i) => (
        <li
          key={i}
          className="relative text-sm leading-relaxed sm:pl-0"
        >
          <span
            aria-hidden="true"
            className="mr-2.5 inline-block w-6 text-right align-top font-mono text-xs text-muted-foreground tabular-nums sm:absolute sm:-left-9 sm:mr-0 sm:mt-[0.2em] sm:w-6"
          >
            {String(i + start).padStart(2, "0")}
          </span>
          <span className="min-w-0">{item}</span>
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
