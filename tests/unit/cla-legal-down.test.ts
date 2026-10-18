import { describe, expect, it } from "vitest";

// GPLATLEGAL-61: while GPlatform Legal cannot answer, a moved project's CLA
// pages say so instead of falling through to the generic error page; a
// refusal is an answer and still throws.

import {
  ClaLegalError,
  LEGAL_DOWN,
  legalIsDown,
  unlessLegalDown,
} from "@/lib/cla/legal";

describe("legalIsDown", () => {
  it("is Legal not reached, or failing on its side", () => {
    expect(legalIsDown(new ClaLegalError(null, null, "not reached"))).toBe(
      true,
    );
    expect(legalIsDown(new ClaLegalError(503, null, "unavailable"))).toBe(true);
    expect(legalIsDown(new ClaLegalError(500, null, "failed"))).toBe(true);
  });

  it("is not a refusal, nor any other error", () => {
    expect(
      legalIsDown(new ClaLegalError(409, "cla.version-moved", "moved")),
    ).toBe(false);
    expect(legalIsDown(new ClaLegalError(401, "auth.required", "key"))).toBe(
      false,
    );
    expect(legalIsDown(new Error("database"))).toBe(false);
  });
});

describe("unlessLegalDown", () => {
  it("gives the reads' result while Legal answers", async () => {
    await expect(unlessLegalDown(async () => 42)).resolves.toBe(42);
  });

  it("gives LEGAL_DOWN while Legal cannot answer", async () => {
    await expect(
      unlessLegalDown(async () => {
        throw new ClaLegalError(
          null,
          null,
          "GPlatform Legal could not be reached.",
        );
      }),
    ).resolves.toBe(LEGAL_DOWN);
  });

  it("still throws a refusal and any other error", async () => {
    const refusal = new ClaLegalError(409, "cla.version-moved", "moved");
    await expect(
      unlessLegalDown(async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    const other = new Error("database");
    await expect(
      unlessLegalDown(async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});
