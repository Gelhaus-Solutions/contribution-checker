"use client";

import { createContext, useContext } from "react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/cn";
import { BUILT_IN_BRAND, wordmarkParts, type Brand } from "@/lib/brand";

/**
 * The instance's name and mark for every place that draws them (GPLATSSO-36).
 *
 * The root layout reads the brand once per render (`ownBrand`) and hands it
 * down here, so the header, the footer and the error pages, client or server,
 * draw the same one on first paint without asking anything themselves.
 * Outside the provider, which is only the global error page, the brand is the
 * built-in one.
 */

const BrandContext = createContext<Brand>(BUILT_IN_BRAND);

export function BrandProvider({
  brand,
  children,
}: {
  brand: Brand;
  children: React.ReactNode;
}) {
  return (
    <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
  );
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}

/**
 * `BrandMark`, or the catalogue's mark where the instance reads one. Sized by
 * `className` as `BrandMark` is, so a draw site swaps one for the other and
 * nothing around it moves.
 *
 * The catalogue's mark is a plain image at the address the entry gives: that
 * file never changes, so the browser caches it. It is drawn in its own colours,
 * so a `text-*` class on the site has nothing to colour.
 */
export function BrandLogo({ className }: { className?: string }) {
  const { markUrl } = useBrand();
  if (markUrl === null) return <BrandMark className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0", className)}
    />
  );
}

/** The name as the wordmark sets it: lowercase words, a muted slash between. */
export function BrandWordmark() {
  const parts = wordmarkParts(useBrand().name);
  return (
    <>
      {parts.map((word, index) => (
        <span key={`${index}-${word}`}>
          {index > 0 ? <span className="text-muted-foreground">/</span> : null}
          {word}
        </span>
      ))}
    </>
  );
}
