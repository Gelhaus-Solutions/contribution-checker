import { cn } from "@/lib/cn";

/**
 * The brand mark: a solid tile with the check and the PR node knocked out of
 * it.
 *
 * The previous version drew everything in `fill-primary/10` and
 * `stroke-primary/40`, so at 16px it was a pale outline with almost no
 * presence. Solid geometry with transparent cuts holds up at favicon size and
 * reads as one shape rather than three faint ones.
 *
 * The cut-outs are a real mask, not a fill in the background color, so the
 * mark works on any ground: the header, a card, or the OG image.
 */
export function BrandMark({
  className,
  /** Override only if two marks with different geometry ever coexist. */
  maskId = "cc-brand-mark",
}: {
  className?: string;
  maskId?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <defs>
        <mask id={maskId}>
          {/* White keeps, black cuts. */}
          <rect width="32" height="32" rx="9" fill="white" />
          <path
            d="M9.25 16.5l4.5 4.5L21.25 12.5"
            fill="none"
            stroke="black"
            strokeWidth="3.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* The notch that separates the node from the tile. */}
          <circle cx="25.25" cy="6.75" r="3.5" fill="black" />
        </mask>
      </defs>
      <rect
        width="32"
        height="32"
        rx="9"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
      {/* The PR node, sitting in its own notch. */}
      <circle cx="25.25" cy="6.75" r="1.9" fill="currentColor" />
    </svg>
  );
}
