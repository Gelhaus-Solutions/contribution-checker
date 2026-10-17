import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wordmarkParts } from "@/lib/brand";

/**
 * Contribution Checker reads its name and mark from GPlatform Identity's
 * catalogue only where GPID_URL is set, and keeps the ones its release ships
 * with wherever there is no entry to draw.
 */

const IDENTITY = "https://identity.example.test";
const ENTRY_URL = `${IDENTITY}/api/v1/catalogue/contribution-checker`;
const ENTRY = {
  slug: "contribution-checker",
  displayName: "Contribution Checker",
  homeUrl: "https://contribute.example.test",
  iconUrl: `${IDENTITY}/api/v1/assets/a1b2c3`,
  monoIconUrl: null,
  updatedAt: "2026-10-17T11:47:03.635Z",
};

let calls: string[] = [];
let answer: () => Response = () => {
  throw new TypeError("fetch failed");
};

async function load(
  gpidUrl: string,
): Promise<typeof import("@/lib/own-brand")> {
  vi.resetModules();
  vi.stubEnv("GPID_URL", gpidUrl);
  return import("@/lib/own-brand");
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ownBrand", () => {
  it("is the built-in brand, and asks nobody, where GPID_URL is not set", async () => {
    const { ownBrand } = await load("");
    expect(await ownBrand()).toEqual({
      name: "contribution-checker",
      markUrl: null,
    });
    expect(calls).toEqual([]);
  });

  it("takes the catalogue's name and mark where GPID_URL is set", async () => {
    answer = () => new Response(JSON.stringify(ENTRY));
    const { ownBrand } = await load(IDENTITY);
    expect(await ownBrand()).toEqual({
      name: "Contribution Checker",
      markUrl: ENTRY.iconUrl,
    });
    expect(calls).toEqual([ENTRY_URL]);
  });

  it("keeps the built-in brand while Identity has never answered, and does not ask on every render", async () => {
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const { ownBrand } = await load(IDENTITY);
    expect(await ownBrand()).toEqual({
      name: "contribution-checker",
      markUrl: null,
    });
    expect(await ownBrand()).toEqual({
      name: "contribution-checker",
      markUrl: null,
    });
    expect(calls).toEqual([ENTRY_URL]);
  });
});

describe("wordmarkParts", () => {
  it("sets the catalogue's name and the built-in one alike", () => {
    expect(wordmarkParts("Contribution Checker")).toEqual([
      "contribution",
      "checker",
    ]);
    expect(wordmarkParts("contribution-checker")).toEqual([
      "contribution",
      "checker",
    ]);
  });

  it("keeps a renamed product's words, and the built-in words for an empty name", () => {
    expect(wordmarkParts("PR  Gate")).toEqual(["pr", "gate"]);
    expect(wordmarkParts("  ")).toEqual(["contribution", "checker"]);
  });
});
