import { describe, expect, it } from "vitest";
import {
  documentsToAccept,
  MIN_NOTICE_MS,
  rolloutFrom,
  safeNext,
  standingAt,
  termsRefusesWrites,
  termsVersions,
  type Rollout,
} from "@/lib/terms";

// Every case asks at a fixed instant, never the clock: the dates below are the
// operator's for the other products, used here only as a realistic example.
const ROLLOUT = rolloutFrom("2026-10-08T00:00:00+02:00", "2026-11-20T00:00:00+01:00")!;
const STEP = new Date("2026-10-01T20:30:00Z");
const OLD = new Date("2026-09-10T10:00:00Z");
const NEW = new Date("2026-10-02T10:00:00Z");
const BEFORE_NOTICE = new Date("2026-10-05T12:00:00Z");
const DURING_NOTICE = new Date("2026-10-20T12:00:00Z");
const IN_FORCE = new Date("2026-11-21T12:00:00Z");

const V1 = "contribution-checker-terms-2026-09-06+gs-terms-2026-09-06";
const V2 = "contribution-checker-terms-2026-10-01+gs-terms-2026-10-01";

function at(now: Date, createdAt: Date, accepted: string[], rollout: Rollout | null = ROLLOUT) {
  return standingAt({ now, createdAt, stepSince: STEP, accepted, versions: termsVersions(rollout) });
}

describe("the rollout from the environment", () => {
  it("is none when neither date is set", () => {
    expect(rolloutFrom(undefined, undefined)).toBeNull();
  });
  it("refuses one date without the other", () => {
    expect(() => rolloutFrom("2026-10-08T00:00:00+02:00", undefined)).toThrow();
    expect(() => rolloutFrom(undefined, "2026-11-20T00:00:00+01:00")).toThrow();
  });
  it("refuses a notice shorter than six weeks and a day", () => {
    expect(() => rolloutFrom("2026-10-08T00:00:00Z", "2026-11-19T00:00:00Z")).toThrow();
    const exact = new Date(Date.parse("2026-10-08T00:00:00Z") + MIN_NOTICE_MS).toISOString();
    expect(rolloutFrom("2026-10-08T00:00:00Z", exact)).not.toBeNull();
  });
});

describe("with no rollout set", () => {
  it("leaves an older account that never accepted alone", () => {
    expect(at(DURING_NOTICE, OLD, [], null)).toMatchObject({ kind: "quiet", record: V1 });
  });
  it("makes a new account accept before anything else", () => {
    expect(at(DURING_NOTICE, NEW, [], null)).toMatchObject({ kind: "first", record: V1 });
  });
  it("counts an acceptance of the versions in force", () => {
    expect(at(DURING_NOTICE, NEW, [V1], null).kind).toBe("agreed");
  });
});

describe("a rollout, before its notice", () => {
  it("changes nothing", () => {
    expect(at(BEFORE_NOTICE, OLD, [])).toMatchObject({ kind: "quiet", record: V1 });
    expect(at(BEFORE_NOTICE, NEW, [V1])).toMatchObject({ kind: "agreed", record: V1 });
  });
});

describe("a rollout, during its notice", () => {
  it("asks an older account that never accepted, with the date it binds", () => {
    const s = at(DURING_NOTICE, OLD, []);
    expect(s.kind).toBe("asked");
    expect(s.inForceFrom?.toISOString()).toBe("2026-11-19T23:00:00.000Z");
    expect(s.record).toBe(V2);
  });
  it("asks an account on the old versions", () => {
    expect(at(DURING_NOTICE, NEW, [V1]).kind).toBe("asked");
  });
  it("has a new account accept the announced versions", () => {
    expect(at(DURING_NOTICE, NEW, [])).toMatchObject({ kind: "first", record: V2 });
  });
  it("is done for an account that accepted the announced versions", () => {
    expect(at(DURING_NOTICE, NEW, [V1, V2]).kind).toBe("agreed");
  });
});

describe("a rollout, once it binds", () => {
  it("restricts an older account that never accepted", () => {
    expect(at(IN_FORCE, OLD, []).kind).toBe("restricted");
  });
  it("restricts an account still on the old versions", () => {
    expect(at(IN_FORCE, NEW, [V1]).kind).toBe("restricted");
  });
  it("restricts an account that accepted only one of the two new versions", () => {
    expect(at(IN_FORCE, NEW, [V1, "contribution-checker-terms-2026-09-06+gs-terms-2026-10-01"]).kind).toBe(
      "restricted",
    );
  });
  it("leaves an account that accepted the new versions alone", () => {
    expect(at(IN_FORCE, OLD, [V2]).kind).toBe("agreed");
  });
});

describe("the page and the gate", () => {
  it("shows the newest version of each document, with the frozen copy", () => {
    const docs = documentsToAccept(termsVersions(ROLLOUT), DURING_NOTICE);
    expect(docs.map((d) => d.archiveUrl)).toEqual([
      "https://gplatform.org/legal/contribution-checker-terms-2026-10-01",
      "https://gplatform.org/legal/gs-terms-2026-10-01",
    ]);
    expect(docs.every((d) => !d.inForce)).toBe(true);
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
