import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every place that draws the product's mark, name, title or favicon goes
 * through the brand the root layout reads (GPLATSSO-36), and the header swaps
 * Hexclave's user button for Identity's controls only where they are set up.
 *
 * SOURCE guards: these files are `.tsx` and this suite runs `.ts` in node.
 * What a regression would change is an import or a prop, and that is what is
 * read. Where the brand comes from is `own-brand.test.ts`'s business.
 */

const SRC = path.resolve(__dirname, "../../src");
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/u.test(name) ? [full] : [];
  });
}

/** Where BrandMark may still be drawn directly. */
const MAY_DRAW_BRANDMARK = new Set([
  "components/brand.tsx", // the fallback itself
  "components/brand-mark.tsx",
  // A picture of the bot's comment on GitHub, where the bot is the GitHub
  // App and wears the App's own avatar, not the catalogue's mark.
  "components/marketing/pr-comment-card.tsx",
]);

describe("draw sites", () => {
  it("draw the mark through BrandLogo, never BrandMark", () => {
    const offenders = sources(SRC)
      .map((full) => path.relative(SRC, full))
      .filter((file) => !MAY_DRAW_BRANDMARK.has(file))
      .filter((file) => /from "@\/components\/brand-mark"/u.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("find the import they look for in brand.tsx, which falls back to it", () => {
    expect(read("components/brand.tsx")).toMatch(
      /from "@\/components\/brand-mark"/u,
    );
  });

  it.each(["components/site-header.tsx", "components/marketing/footer.tsx"])(
    "set the brand's name as the wordmark, not a literal: %s",
    (file) => {
      const source = read(file);
      expect(source).toMatch(/<BrandLogo\b/u);
      expect(source).toMatch(/<BrandWordmark \/>/u);
      expect(source).not.toMatch(/>\s*contribution\s*</u);
    },
  );
});

describe("the root layout", () => {
  const layout = read("app/layout.tsx");

  it("hands the brand it read to every draw site", () => {
    expect(layout).toMatch(/ownBrand\(\)/u);
    expect(layout).toMatch(/<BrandProvider brand=\{brand\}>/u);
  });

  it("titles the page and links the favicon from the brand", () => {
    expect(layout).toMatch(/default: brand\.name,/u);
    expect(layout).toMatch(/template: `%s · \$\{brand\.name\}`/u);
    expect(layout).toMatch(/url: brand\.markUrl \?\? "\/mark\.svg"/u);
  });

  it("has no icon file, which would override the favicon it chooses", () => {
    for (const name of [
      "icon.svg",
      "icon.png",
      "icon.ico",
      "icon.tsx",
      "icon.ts",
      "favicon.ico",
    ]) {
      expect(existsSync(path.join(SRC, "app", name)), name).toBe(false);
    }
    expect(existsSync(path.join(SRC, "app", "mark.svg", "route.ts"))).toBe(
      true,
    );
  });
});

describe("the header", () => {
  it("tells the user cluster whether Identity's controls are set up", () => {
    expect(read("components/site-header.tsx")).toMatch(
      /identityChrome=\{identityChrome !== null\}/u,
    );
  });

  it("draws Identity's controls where they are set up, and Hexclave's button elsewhere", () => {
    const cluster = read("components/user-cluster.tsx");
    expect(cluster).toMatch(/if \(identityChrome\) \{[\s\S]*<HeaderChrome /u);
    expect(cluster).toMatch(/<UserButton /u);
  });
});
