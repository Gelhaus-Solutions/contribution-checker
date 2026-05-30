import { describe, expect, it } from "vitest";
import { parsePrNumbersFromMergeRef } from "@/lib/github/webhook";

describe("parsePrNumbersFromMergeRef", () => {
  it("extracts a single PR number from a queue branch ref", () => {
    const ref =
      "refs/heads/gh-readonly-queue/main/pr-5-9e3f2a1b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f";
    expect(parsePrNumbersFromMergeRef(ref)).toEqual([5]);
  });

  it("extracts multiple PR numbers from a batched group, de-duplicated and in order", () => {
    const ref =
      "refs/heads/gh-readonly-queue/main/pr-12-aaaa/pr-7-bbbb/pr-12-cccc";
    expect(parsePrNumbersFromMergeRef(ref)).toEqual([12, 7]);
  });

  it("returns an empty array when no PR segment is present", () => {
    expect(parsePrNumbersFromMergeRef("refs/heads/main")).toEqual([]);
    expect(parsePrNumbersFromMergeRef("")).toEqual([]);
  });
});
