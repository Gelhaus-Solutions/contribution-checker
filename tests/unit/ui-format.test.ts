import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  formatRelative,
} from "@/lib/ui/format";

const T = "2026-08-16T19:45:52.356Z";

describe("formatDate", () => {
  it("renders an ISO day", () => {
    expect(formatDate(new Date(T))).toBe("2026-08-16");
    expect(formatDate(T)).toBe("2026-08-16");
  });

  it("formats in UTC regardless of the host timezone", () => {
    // A date late in the UTC day is the case that would roll backwards under a
    // negative-offset local timezone. Server and client must agree, or the
    // string differs between the SSR pass and hydration.
    expect(formatDate("2026-08-16T23:59:59.000Z")).toBe("2026-08-16");
    expect(formatDate("2026-08-16T00:00:00.000Z")).toBe("2026-08-16");
  });

  it("falls back instead of printing Invalid Date", () => {
    expect(formatDate(null)).toBe("n/a");
    expect(formatDate(undefined)).toBe("n/a");
    expect(formatDate("not a date")).toBe("n/a");
    expect(formatDate(null, "never")).toBe("never");
  });
});

describe("formatDateTime", () => {
  it("renders to the minute with a space separator", () => {
    expect(formatDateTime(T)).toBe("2026-08-16 19:45");
  });

  it("renders to the second when asked", () => {
    expect(formatDateTimeSeconds(T)).toBe("2026-08-16 19:45:52");
  });

  it("falls back on bad input", () => {
    expect(formatDateTime(undefined)).toBe("n/a");
    expect(formatDateTimeSeconds("nope")).toBe("n/a");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  it("buckets by magnitude", () => {
    expect(formatRelative("2026-08-16T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelative("2026-08-16T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatRelative("2026-08-16T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelative("2026-08-13T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("gives up on relative past a month and shows the date", () => {
    expect(formatRelative("2026-01-02T12:00:00.000Z", now)).toBe("2026-01-02");
  });

  it("treats a future timestamp as now rather than printing a negative", () => {
    expect(formatRelative("2026-09-01T12:00:00.000Z", now)).toBe("just now");
  });

  it("is pure: the same inputs give the same answer", () => {
    expect(formatRelative(T, "2026-08-17T19:45:52.356Z")).toBe("1d ago");
  });
});
