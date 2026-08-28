import { describe, expect, it } from "vitest";
import {
  parseStandingChecks,
  parseStandingChecksInput,
  serializeStandingChecks,
  standingCheckKey,
} from "@/lib/qa/settings";
import {
  DEFAULT_STATUS_LABELS,
  decodeStatus,
  hashPayload,
  parseStatusMap,
  serializeStatusMap,
} from "@/lib/qa/board/types";

describe("parseStandingChecks", () => {
  it("reads a stored list", () => {
    expect(parseStandingChecks('["Sign-in works","Checkout"]')).toEqual([
      "Sign-in works",
      "Checkout",
    ]);
  });

  it.each([null, undefined, "", "not json", '"a string"', "{}", "[1,2]"])(
    "reads %s as no checks rather than throwing",
    (raw) => {
      expect(parseStandingChecks(raw as string)).toEqual([]);
    },
  );

  it("drops blanks and de-duplicates case-insensitively", () => {
    expect(
      parseStandingChecks('["Sign-in","  ","sign-in","Checkout"]'),
    ).toEqual(["Sign-in", "Checkout"]);
  });

  it("caps a runaway list", () => {
    const many = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => `check ${i}`),
    );
    expect(parseStandingChecks(many)).toHaveLength(40);
  });
});

describe("parseStandingChecksInput", () => {
  it("reads one check per line", () => {
    expect(parseStandingChecksInput("Sign-in works\n\nCheckout  \n")).toEqual([
      "Sign-in works",
      "Checkout",
    ]);
  });
});

describe("serializeStandingChecks", () => {
  it("round-trips, so a no-op save is not recorded as a change", () => {
    const input = ["Sign-in works", "Checkout"];
    const stored = serializeStandingChecks(input);
    expect(serializeStandingChecks(parseStandingChecks(stored))).toBe(stored);
  });
});

describe("standingCheckKey", () => {
  it("is stable for the same text and position", () => {
    expect(standingCheckKey("Sign-in works", 0)).toBe(
      standingCheckKey("Sign-in works", 0),
    );
  });

  it("changes when the text is edited, retiring the old verdict", () => {
    // An edited check is a different question, so carrying "passed" onto it
    // would claim somebody verified something they never read.
    expect(standingCheckKey("Sign-in works", 0)).not.toBe(
      standingCheckKey("Sign-in works on mobile", 0),
    );
  });

  it("keeps two punctuation-only variants distinct", () => {
    expect(standingCheckKey("Sign in!", 0)).not.toBe(
      standingCheckKey("Sign in?", 1),
    );
  });
});

describe("status map", () => {
  it("defaults every status", () => {
    expect(parseStatusMap(null)).toEqual(DEFAULT_STATUS_LABELS);
  });

  it("falls back per key, so a partial map still works", () => {
    const map = parseStatusMap('{"QA_PASSED":"Done"}');
    expect(map.QA_PASSED).toBe("Done");
    expect(map.QA_FAILED).toBe(DEFAULT_STATUS_LABELS.QA_FAILED);
  });

  it.each(["not json", "[]", '{"QA_PASSED":42}', '{"QA_PASSED":"  "}'])(
    "ignores junk (%s)",
    (raw) => {
      expect(parseStatusMap(raw).QA_PASSED).toBe(
        DEFAULT_STATUS_LABELS.QA_PASSED,
      );
    },
  );

  it("round-trips through the serializer", () => {
    const stored = serializeStatusMap({ ...DEFAULT_STATUS_LABELS, QA_PASSED: "Done" });
    expect(parseStatusMap(stored).QA_PASSED).toBe("Done");
  });

  it("decodes a card's status back, ignoring case and padding", () => {
    const map = parseStatusMap(null);
    expect(decodeStatus(map, "  verified ")).toBe("QA_PASSED");
  });

  it("returns null for a name outside the mapping", () => {
    // Somebody renamed a Notion option or dragged a card to an unmapped list.
    expect(decodeStatus(parseStatusMap(null), "In limbo")).toBeNull();
    expect(decodeStatus(parseStatusMap(null), null)).toBeNull();
  });
});

describe("hashPayload", () => {
  const base = {
    title: "#1 Thing",
    status: "QA_PENDING" as const,
    url: null,
    summary: null,
    qaSteps: null,
    notes: null,
  };

  it("is stable for identical content", () => {
    expect(hashPayload(base)).toBe(hashPayload({ ...base }));
  });

  it("changes when the status moves", () => {
    // The loop guard depends on exactly this.
    expect(hashPayload(base)).not.toBe(
      hashPayload({ ...base, status: "QA_PASSED" }),
    );
  });

  it("changes when a note is added", () => {
    expect(hashPayload(base)).not.toBe(
      hashPayload({ ...base, notes: "broke" }),
    );
  });
});
