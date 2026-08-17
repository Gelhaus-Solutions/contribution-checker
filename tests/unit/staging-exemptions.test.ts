import { describe, expect, it } from "vitest";
import {
  isAggregatePr,
  stagingRetargetSkipReason,
} from "@/lib/github/staging";

const BASE_REPO = "postiz/postiz";

function args(overrides: Partial<Parameters<typeof stagingRetargetSkipReason>[0]> = {}) {
  return {
    baseRef: "main",
    head: { ref: "feature", repoFullName: "contributor/postiz" },
    baseRepoFullName: BASE_REPO,
    defaultBranch: "main",
    stagingBranch: "staging",
    prNumber: 42,
    aggregatePrNumber: null,
    prLabels: [] as string[],
    optOutLabel: "staging:opt-out",
    authorGhLogin: "octocat",
    bypassHandles: [] as string[],
    ...overrides,
  };
}

describe("stagingRetargetSkipReason", () => {
  it("retargets an ordinary PR based on the default branch", () => {
    expect(stagingRetargetSkipReason(args())).toBeNull();
  });

  it("retargets regardless of what the contributor gate would decide", () => {
    // No gate input reaches this function at all: that is the requirement
    // "retargeting runs independently of the decision", made structural.
    expect(Object.keys(args())).not.toContain("decision");
    expect(stagingRetargetSkipReason(args())).toBeNull();
  });

  it("is a no-op once the base is already staging", () => {
    // This is the loop guard: our own PATCH echoes back as pull_request.edited
    // and lands here with the base already moved.
    expect(stagingRetargetSkipReason(args({ baseRef: "staging" }))).toBe(
      "base_not_default",
    );
  });

  it("skips a PR carrying the opt-out label", () => {
    expect(
      stagingRetargetSkipReason(args({ prLabels: ["staging:opt-out"] })),
    ).toBe("opt_out_label");
  });

  it("skips accounts on the bypass list, including glob patterns", () => {
    expect(
      stagingRetargetSkipReason(
        args({ authorGhLogin: "dependabot[bot]", bypassHandles: ["*[bot]"] }),
      ),
    ).toBe("bypass_handle");
  });

  it("skips the tracked aggregate PR", () => {
    expect(
      stagingRetargetSkipReason(args({ prNumber: 7, aggregatePrNumber: 7 })),
    ).toBe("aggregate_pr");
  });

  it("skips an untracked staging -> default PR on its structure alone", () => {
    // Covers the window between opening the aggregate PR and persisting its
    // number, and a maintainer who opened the same PR by hand.
    expect(
      stagingRetargetSkipReason(
        args({ head: { ref: "staging", repoFullName: BASE_REPO } }),
      ),
    ).toBe("aggregate_pr");
  });

  it("still retargets a fork whose branch happens to be named staging", () => {
    expect(
      stagingRetargetSkipReason(
        args({ head: { ref: "staging", repoFullName: "contributor/postiz" } }),
      ),
    ).toBeNull();
  });

  it("retargets a PR whose fork was deleted", () => {
    expect(
      stagingRetargetSkipReason(
        args({ head: { ref: "feature", repoFullName: null } }),
      ),
    ).toBeNull();
  });

  it("does nothing when staging is the default branch", () => {
    expect(
      stagingRetargetSkipReason(
        args({ stagingBranch: "main", defaultBranch: "main" }),
      ),
    ).toBe("staging_is_default");
  });

  it("rewrites the base back after a human reverts it", () => {
    // A human moved it back to main; nothing exempts it, so it goes again.
    expect(stagingRetargetSkipReason(args({ baseRef: "main" }))).toBeNull();
  });

  it("respects the opt-out label after a human reverts the base", () => {
    expect(
      stagingRetargetSkipReason(
        args({ baseRef: "main", prLabels: ["staging:opt-out"] }),
      ),
    ).toBe("opt_out_label");
  });
});

describe("isAggregatePr", () => {
  const base = {
    prNumber: 10,
    trackedPrNumber: null as number | null,
    head: { ref: "staging", repoFullName: BASE_REPO },
    baseRef: "main",
    baseRepoFullName: BASE_REPO,
    stagingBranch: "staging",
    defaultBranch: "main",
  };

  it("matches the tracked number even when the shape has drifted", () => {
    expect(
      isAggregatePr({
        ...base,
        trackedPrNumber: 10,
        head: { ref: "something-else", repoFullName: BASE_REPO },
      }),
    ).toBe(true);
  });

  it("matches structurally when nothing is tracked yet", () => {
    expect(isAggregatePr(base)).toBe(true);
  });

  it("does not match a fork PR from a branch named staging", () => {
    expect(
      isAggregatePr({
        ...base,
        head: { ref: "staging", repoFullName: "contributor/postiz" },
      }),
    ).toBe(false);
  });

  it("does not match a staging -> other-branch PR", () => {
    expect(isAggregatePr({ ...base, baseRef: "release-2" })).toBe(false);
  });
});
