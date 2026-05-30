import { describe, expect, it } from "vitest";
import { matchesAnyPattern } from "@/lib/applications/decide-pr";

describe("bypass list pattern match", () => {
  it("matches exact login (case-insensitive)", () => {
    expect(matchesAnyPattern("Octocat", ["octocat"])).toBe(true);
    expect(matchesAnyPattern("octocat", ["OCTOCAT"])).toBe(true);
  });

  it("matches *[bot] glob with literal brackets", () => {
    expect(matchesAnyPattern("dependabot[bot]", ["*[bot]"])).toBe(true);
    expect(matchesAnyPattern("renovate[bot]", ["*[bot]"])).toBe(true);
    expect(matchesAnyPattern("octocat", ["*[bot]"])).toBe(false);
  });

  it("matches anchored, does not match substrings", () => {
    expect(matchesAnyPattern("dependabot[bot]-extra", ["*[bot]"])).toBe(false);
  });

  it("does not match unrelated logins", () => {
    expect(matchesAnyPattern("attacker", ["dependabot[bot]", "renovate[bot]"])).toBe(false);
  });

  it("ignores empty patterns", () => {
    expect(matchesAnyPattern("octocat", ["", "  ", "octocat"])).toBe(true);
    expect(matchesAnyPattern("octocat", ["", "  "])).toBe(false);
  });

  it("supports ? single-char wildcard", () => {
    expect(matchesAnyPattern("user1", ["user?"])).toBe(true);
    expect(matchesAnyPattern("user12", ["user?"])).toBe(false);
  });
});
