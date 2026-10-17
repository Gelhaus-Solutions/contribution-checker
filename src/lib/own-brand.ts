import "server-only";
import { createCatalogue } from "@ghub/identity-chrome";
import { BRAND_SLUG, BUILT_IN_BRAND, type Brand } from "@/lib/brand";
import { env } from "@/lib/env";

/**
 * Contribution Checker's own name and mark, read from GPlatform Identity's
 * catalogue (GPLATSSO-36), so a rename or a new mark on Identity's product
 * screen reaches the header, the title and the favicon within a minute, with
 * no release.
 *
 * **On only where `GPID_URL` is set.** The catalogue needs no token. A
 * self-hosted instance keeps the mark and name its release ships with, and so
 * does an instance whose Identity has never answered: an entry once read is
 * kept through an outage, and a failed ask is held for a minute like an answer
 * (`createCatalogue`), so an outage costs a render at most one wait a minute.
 */

const catalogue = env.GPID_URL
  ? createCatalogue({ baseUrl: env.GPID_URL, timeoutMs: 2000 })
  : null;

export async function ownBrand(): Promise<Brand> {
  if (catalogue === null) return BUILT_IN_BRAND;
  const entry = await catalogue.entry(BRAND_SLUG);
  return entry === null
    ? BUILT_IN_BRAND
    : { name: entry.displayName, markUrl: entry.iconUrl };
}
