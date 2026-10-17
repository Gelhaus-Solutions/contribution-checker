/**
 * The name and mark this instance draws itself with.
 *
 * Plain data with no imports, so a client component can hold one. Where it
 * comes from is `own-brand.ts`, which only the server reads.
 */

/** Contribution Checker's slug in GPlatform Identity's catalogue. */
export const BRAND_SLUG = "contribution-checker";

export interface Brand {
  /** The product's name: the catalogue's, or the one a release ships with. */
  name: string;
  /**
   * The catalogue's colour mark, at an address that never changes its file,
   * or null for the mark a release ships with (`BrandMark`).
   */
  markUrl: string | null;
}

/** What a self-hosted instance draws, and what any instance falls back to. */
export const BUILT_IN_BRAND: Brand = {
  name: "contribution-checker",
  markUrl: null,
};

/**
 * The words of the wordmark, which sets them lowercase with a slash between:
 * "Contribution Checker" and "contribution-checker" both read
 * contribution/checker, so a rename in the catalogue keeps the look.
 */
export function wordmarkParts(name: string): string[] {
  const words = name
    .trim()
    .split(/[\s\-_/]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.length > 0 ? words : wordmarkParts(BUILT_IN_BRAND.name);
}
