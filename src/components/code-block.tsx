import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/cn";

/**
 * A <pre> with a filename bar and a copy button. Server component; only the
 * button itself is client-side.
 *
 * Replaces the bare `<pre>` blocks on the repos and setup pages. Those carry
 * two generated ~100-line workflow YAML files and several multi-line env
 * blocks, and until now the only way to get one out of the page was to select
 * it by hand inside a horizontally scrolling box.
 */
export function CodeBlock({
  code,
  filename,
  language,
  maxHeight = "24rem",
  className,
}: {
  code: string;
  /** Rendered in the header bar, in mono. */
  filename?: string;
  /** Label only. There is no syntax highlighting here on purpose. */
  language?: string;
  /** Caps the scroll box so a long file does not own the page. */
  maxHeight?: string;
  className?: string;
}) {
  const header = filename ?? language;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-muted/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/60 py-1 pr-1 pl-3">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {header}
        </span>
        <CopyButton
          value={code}
          label={filename ? `Copy ${filename}` : "Copy"}
          iconOnly
        />
      </div>
      <pre
        className="overflow-auto overscroll-contain p-3 text-xs leading-relaxed"
        style={{ maxHeight }}
        tabIndex={0}
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
