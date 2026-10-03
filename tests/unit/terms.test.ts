import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bind, parseSnapshot } from "@ghub/terms-rules";
import { describe, expect, it } from "vitest";
import {
  decidingRecord,
  documentsToAccept,
  safeNext,
  standingAt,
  termsRefusesWrites,
  weighed,
} from "@/lib/terms";

// GPlatform Terms' production snapshot 225, cut down to this surface's two
// documents: the 2026-10-03 versions announced on 3 Oct 2026 at 17:33Z, in
// force 20 Nov 2026 00:00 Berlin. Every case asks at a fixed instant, never
// the clock.
const RULES = bind(
  parseSnapshot(
    JSON.parse(
      readFileSync(join(__dirname, "../fixtures/gpterms-snapshot-225-contribution-checker.json"), "utf8"),
    ),
  ),
);

const OLD = new Date("2026-09-10T10:00:00Z");
const NEW = new Date("2026-10-02T10:00:00Z");
const BEFORE_NOTICE = new Date("2026-10-03T12:00:00Z");
const DURING_NOTICE = new Date("2026-10-20T12:00:00Z");
const IN_FORCE_FROM = new Date("2026-11-19T23:00:00Z");
const IN_FORCE = new Date("2026-11-21T12:00:00Z");

const V1 = "contribution-checker-terms-2026-09-06+gs-terms-2026-09-06";
const V2 = "contribution-checker-terms-2026-10-03.2+gs-terms-2026-10-03";

function at(now: Date, createdAt: Date, accepted: string[]) {
  return standingAt(RULES, { createdAt, accepted }, now);
}

describe("before the notice", () => {
  it("leaves an older account that never accepted alone", () => {
    expect(at(BEFORE_NOTICE, OLD, [])).toMatchObject({ kind: "quiet", record: V1 });
  });
  it("makes a new account accept before anything else", () => {
    expect(at(BEFORE_NOTICE, NEW, [])).toMatchObject({ kind: "first", record: V1 });
  });
  it("counts an acceptance of the versions in force", () => {
    expect(at(BEFORE_NOTICE, NEW, [V1]).kind).toBe("agreed");
  });
});

describe("during the notice", () => {
  it("asks an older account that never accepted, and lets it carry on (operator, 2026-10-03)", () => {
    expect(at(DURING_NOTICE, OLD, [])).toEqual({
      kind: "asked",
      inForceFrom: IN_FORCE_FROM,
      record: V2,
    });
  });
  it("asks an account that accepted the versions in force", () => {
    expect(at(DURING_NOTICE, NEW, [V1])).toMatchObject({ kind: "asked", record: V2 });
  });
  it("has a new account accept the announced versions, so it is not asked again", () => {
    expect(at(DURING_NOTICE, NEW, [])).toMatchObject({ kind: "first", record: V2 });
  });
  it("leaves an account that accepted them alone", () => {
    expect(at(DURING_NOTICE, OLD, [V1, V2]).kind).toBe("agreed");
  });
});

describe("once the new versions bind", () => {
  it("restricts an account that has not accepted them, older ones included", () => {
    expect(at(IN_FORCE, OLD, []).kind).toBe("restricted");
    expect(at(IN_FORCE, NEW, [V1]).kind).toBe("restricted");
  });
  it("leaves an account that accepted them alone", () => {
    expect(at(IN_FORCE, OLD, [V2]).kind).toBe("agreed");
  });
});

describe("what the rules decide from", () => {
  it("is the newest acceptance, the versions in force when the step began, or nothing", () => {
    expect(decidingRecord(RULES, { createdAt: NEW, accepted: [V1, V2] })).toBe(V2);
    expect(decidingRecord(RULES, { createdAt: OLD, accepted: [] })).toBe(V1);
    expect(decidingRecord(RULES, { createdAt: NEW, accepted: [] })).toBeNull();
  });
});

describe("the service's answer", () => {
  const asked = at(DURING_NOTICE, OLD, []);
  it("never restricts what this product's record does not", () => {
    expect(weighed(asked, { kind: "restricted" }, V2, true)).toBe(asked);
  });
  it("wins otherwise, and an older account it calls agreed stays quiet", () => {
    expect(weighed(asked, { kind: "agreed" }, V2, false)).toMatchObject({ kind: "agreed" });
    expect(weighed(asked, { kind: "agreed" }, V2, true)).toMatchObject({ kind: "quiet" });
    const restricted = at(IN_FORCE, OLD, []);
    expect(weighed(restricted, { kind: "restricted" }, V2, true).kind).toBe("restricted");
  });
  it("leaves a new account to accept first", () => {
    const first = at(DURING_NOTICE, NEW, []);
    expect(weighed(first, { kind: "agreed" }, V2, true)).toBe(first);
  });
});

describe("the page and the gate", () => {
  it("shows the newest version of each document, with the frozen copy", () => {
    const docs = documentsToAccept(RULES, DURING_NOTICE);
    expect(docs.map((d) => [d.version, d.archiveUrl])).toEqual([
      ["2026-10-03.2", "https://gplatform.org/legal/contribution-checker-terms-2026-10-03.2"],
      ["2026-10-03", "https://gplatform.org/legal/gs-terms-2026-10-03"],
    ]);
    expect(docs.every((d) => !d.inForce && d.inForceFrom.getTime() === IN_FORCE_FROM.getTime())).toBe(true);
  });
  it("refuses writes only before a first acceptance and when behind", () => {
    expect(termsRefusesWrites("first")).toBe(true);
    expect(termsRefusesWrites("restricted")).toBe(true);
    for (const kind of ["off", "agreed", "quiet", "asked", undefined] as const) {
      expect(termsRefusesWrites(kind)).toBe(false);
    }
  });
  it("sends people back only to a path on this site", () => {
    expect(safeNext("/p/postiz")).toBe("/p/postiz");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext(null)).toBe("/dashboard");
  });
});
