import { describe, expect, it } from "vitest";
import { COUNTRIES, isValidCountryCode } from "@/lib/countries";

describe("countries", () => {
  it("contains well-known codes with names", () => {
    const us = COUNTRIES.find((c) => c.code === "US");
    expect(us?.name).toBe("United States");
    expect(COUNTRIES.length).toBeGreaterThan(200);
  });

  it("validates codes case-insensitively and trims", () => {
    expect(isValidCountryCode("DE")).toBe(true);
    expect(isValidCountryCode("de")).toBe(true);
    expect(isValidCountryCode("  us  ")).toBe(true);
  });

  it("rejects invalid / non-existent codes", () => {
    expect(isValidCountryCode("ZZ")).toBe(false);
    expect(isValidCountryCode("USA")).toBe(false);
    expect(isValidCountryCode("")).toBe(false);
  });
});
