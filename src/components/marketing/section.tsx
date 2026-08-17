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
  rail = true,
}: {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  divider?: boolean;
  /**
   * Put the heading and lead in a sticky left rail and the content beside it,
   * on xl and up. This is how the page uses a wide viewport: simply widening a
   * single column would push body text past a readable measure, and leaving it
   * narrow stranded ~400px of empty margin on each side of a 1900px screen.
   *
   * Pages that already have their own left or right rail (how-it-works and its
   * table of contents) pass `rail={false}` so the columns do not stack up.
   */
  rail?: boolean;
}) {
  const head = (
    <>
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
    </>
  );

  const railed = rail && Boolean(title);

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
      {railed ? (
        <div className="xl:grid xl:grid-cols-[18rem_minmax(0,1fr)] xl:gap-x-16">
          <div className="xl:sticky xl:top-20 xl:self-start">{head}</div>
          {children ? <div className="mt-6 xl:mt-0">{children}</div> : null}
        </div>
      ) : (
        <>
          {head}
          {children ? (
            <div className={cn(title && "mt-6")}>{children}</div>
          ) : null}
        </>
      )}
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
    <ol className="max-w-4xl space-y-3.5">
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
    <aside className="max-w-4xl rounded-md border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed">
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      <div className="text-muted-foreground">{children}</div>
    </aside>
  );
}
