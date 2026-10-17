/**
 * The mark a release ships with, as the favicon of an instance that does not
 * read Identity's catalogue (`ownBrand`). Where it does, the root layout links
 * the catalogue's mark instead, at Identity's own address.
 *
 * A route rather than `app/icon.svg`: Next's file convention would override
 * the `icons` the layout chooses between. Same geometry as
 * components/brand-mark.tsx, with literal colours: a favicon renders with no
 * stylesheet, so currentColor and Tailwind classes would resolve to nothing.
 * #006be4 is the cobalt --primary token in sRGB.
 */

const MARK = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="m">
      <rect width="32" height="32" rx="9" fill="white"/>
      <path d="M9.25 16.5l4.5 4.5L21.25 12.5" fill="none" stroke="black" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="25.25" cy="6.75" r="3.5" fill="black"/>
    </mask>
  </defs>
  <rect width="32" height="32" rx="9" fill="#006be4" mask="url(#m)"/>
  <circle cx="25.25" cy="6.75" r="1.9" fill="#006be4"/>
</svg>
`;

export function GET(): Response {
  return new Response(MARK, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}
