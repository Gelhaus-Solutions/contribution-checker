import { describe, expect, it } from "vitest";
import {
  isAggregatePr,
  repointRequestsRevert,
  stagingIgnored,
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
    ignoreLabel: "staging:ignore",
    repointLabel: "staging:repoint",
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

  it("skips a PR carrying the ignore label", () => {
    expect(
      stagingRetargetSkipReason(args({ prLabels: ["staging:ignore"] })),
    ).toBe("ignore_label");
  });

  it("skips a PR carrying the repoint label", () => {
    expect(
      stagingRetargetSkipReason(args({ prLabels: ["staging:repoint"] })),
    ).toBe("repoint_label");
  });

  // Both mean "not onto staging", so the retarget is skipped either way; the
  // reported reason is the label that also governs the other direction.
  it("reports ignore first when a PR carries both labels", () => {
    expect(
      stagingRetargetSkipReason(
        args({ prLabels: ["staging:repoint", "staging:ignore"] }),
      ),
    ).toBe("ignore_label");
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

  it("respects the ignore label after a human reverts the base", () => {
    expect(
      stagingRetargetSkipReason(
        args({ baseRef: "main", prLabels: ["staging:ignore"] }),
      ),
    ).toBe("ignore_label");
  });

  it("respects the repoint label after a human reverts the base", () => {
    expect(
      stagingRetargetSkipReason(
        args({ baseRef: "main", prLabels: ["staging:repoint"] }),
      ),
    ).toBe("repoint_label");
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

describe("stagingIgnored", () => {
  it("recognizes the label wherever the PR currently sits", () => {
    expect(
      stagingIgnored({
        prLabels: ["staging:ignore"],
        ignoreLabel: "staging:ignore",
      }),
    ).toBe(true);
  });

  it("is not fooled by a label that merely looks like it", () => {
    expect(
      stagingIgnored({
        prLabels: ["staging:ignore-me-later"],
        ignoreLabel: "staging:ignore",
      }),
    ).toBe(false);
  });
});

describe("repointRequestsRevert", () => {
  const revertArgs = (overrides: Record<string, unknown> = {}) => ({
    baseRef: "staging",
    stagingBranch: "staging",
    prLabels: ["staging:repoint"],
    repointLabel: "staging:repoint",
    ignoreLabel: "staging:ignore",
    ...overrides,
  });

  it("wants a PR already sitting on staging put back", () => {
    // The skip reason can only prevent a retarget. Once the base is staging,
    // labelling the PR would otherwise do nothing at all.
    expect(repointRequestsRevert(revertArgs())).toBe(true);
  });

  it("wants nothing when the PR is not on staging", () => {
    expect(repointRequestsRevert(revertArgs({ baseRef: "main" }))).toBe(false);
  });

  it("wants nothing without the label", () => {
    expect(repointRequestsRevert(revertArgs({ prLabels: [] }))).toBe(false);
  });

  it("is not fooled by a label that merely looks like the repoint one", () => {
    expect(
      repointRequestsRevert(revertArgs({ prLabels: ["staging:repoint-later"] })),
    ).toBe(false);
  });

  // "Do not move this" and "move this" together: the instruction that does
  // nothing is the one that can be taken back later.
  it("defers to the ignore label when a PR carries both", () => {
    expect(
      repointRequestsRevert(
        revertArgs({ prLabels: ["staging:repoint", "staging:ignore"] }),
      ),
    ).toBe(false);
  });
});
