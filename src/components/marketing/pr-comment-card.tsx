import { BrandMark } from "@/components/brand-mark";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";

/**
 * GitHub comment chrome around a real bot message.
 *
 * The body is produced by buildDecisionMessage, which is the single source the
 * webhook, the CI endpoint, the retroactive denial pass and the CLA re-check
 * all use. Rendering it here rather than retyping it means these examples stay
 * correct when the copy changes.
 */
export function PrCommentCard({
  body,
  label,
}: {
  body: string;
  /** Optional caption above the card, e.g. "No application on file". */
  label?: string;
}) {
  return (
    <figure className="space-y-2">
      {label ? (
        <figcaption className="font-mono text-xs text-muted-foreground">
          {label}
        </figcaption>
      ) : null}
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <BrandMark className="size-4 text-primary" />
          <span className="text-xs font-medium">contribution-checker</span>
          <Badge variant="outline" className="text-[10px]">
            bot
          </Badge>
          <span className="text-xs text-muted-foreground">commented</span>
        </div>
        <div className="px-4 py-3 text-sm">
          <Markdown source={body} />
        </div>
      </div>
    </figure>
  );
}
