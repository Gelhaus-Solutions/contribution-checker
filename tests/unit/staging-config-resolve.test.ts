import { describe, expect, it } from "vitest";
import { resolveStagingConfig } from "@/lib/github/staging";

const PROJECT = {
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: true,
  stagingBranch: "staging",
};

const NO_OVERRIDES = {
  stagingRetargetEnabled: null,
  stagingBatchPrEnabled: null,
  stagingSyncEnabled: null,
  stagingBranch: null,
};

describe("resolveStagingConfig", () => {
  it("inherits every field when the repo overrides nothing", () => {
    const cfg = resolveStagingConfig(PROJECT, NO_OVERRIDES);
    expect(cfg.retargetEnabled).toBe(true);
    expect(cfg.batchPrEnabled).toBe(true);
    expect(cfg.stagingBranch).toBe("staging");
    expect(cfg.overridden).toEqual({
      retargetEnabled: false,
      batchPrEnabled: false,
      syncEnabled: false,
      stagingBranch: false,
    });
  });

  it("inherits when there is no repo row at all", () => {
    expect(resolveStagingConfig(PROJECT, null).stagingBranch).toBe("staging");
  });

  it("lets a repo turn retargeting off while the project has it on", () => {
    // The reason the columns are nullable: `false` has to be distinguishable
    // from "not set", or a repo could never opt out of a project-wide default.
    const cfg = resolveStagingConfig(PROJECT, {
      ...NO_OVERRIDES,
      stagingRetargetEnabled: false,
    });
    expect(cfg.retargetEnabled).toBe(false);
    expect(cfg.batchPrEnabled).toBe(true);
    expect(cfg.overridden.retargetEnabled).toBe(true);
  });

  it("lets a repo turn retargeting on while the project has it off", () => {
    const cfg = resolveStagingConfig(
      { ...PROJECT, stagingRetargetEnabled: false },
      { ...NO_OVERRIDES, stagingRetargetEnabled: true },
    );
    expect(cfg.retargetEnabled).toBe(true);
    expect(cfg.overridden.retargetEnabled).toBe(true);
  });

  it("uses a per-repo branch name over the project default", () => {
    const cfg = resolveStagingConfig(PROJECT, {
      ...NO_OVERRIDES,
      stagingBranch: "next",
    });
    expect(cfg.stagingBranch).toBe("next");
    expect(cfg.overridden.stagingBranch).toBe(true);
  });

  it("treats a blank or whitespace branch override as inherit", () => {
    // An emptied text input posts "", which must mean "inherit" rather than
    // resolving to an unusable empty ref.
    for (const raw of ["", "   "]) {
      const cfg = resolveStagingConfig(PROJECT, {
        ...NO_OVERRIDES,
        stagingBranch: raw,
      });
      expect(cfg.stagingBranch).toBe("staging");
      expect(cfg.overridden.stagingBranch).toBe(false);
    }
  });

  it("trims a branch override rather than passing spaces into a ref", () => {
    const cfg = resolveStagingConfig(PROJECT, {
      ...NO_OVERRIDES,
      stagingBranch: "  next  ",
    });
    expect(cfg.stagingBranch).toBe("next");
  });

  it("resolves the halves independently", () => {
    const cfg = resolveStagingConfig(PROJECT, {
      ...NO_OVERRIDES,
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: false,
    });
    expect(cfg.retargetEnabled).toBe(true);
    expect(cfg.batchPrEnabled).toBe(false);
  });

  it("keeps syncing for a repo that only retargets", () => {
    // Staging still needs to track the default branch when the aggregate PR is
    // off, or every retargeted contributor works from a stale base.
    const cfg = resolveStagingConfig(
      { ...PROJECT, stagingBatchPrEnabled: false },
      NO_OVERRIDES,
    );
    expect(cfg.syncEnabled).toBe(true);
    expect(cfg.anyEnabled).toBe(true);
  });

  it("never syncs a repo that staging routing does not touch", () => {
    // Syncing a branch nothing routes through would be a write to someone's
    // repo for no reason, so the sync default cannot act on its own.
    const cfg = resolveStagingConfig(
      {
        ...PROJECT,
        stagingRetargetEnabled: false,
        stagingBatchPrEnabled: false,
      },
      NO_OVERRIDES,
    );
    expect(cfg.anyEnabled).toBe(false);
    expect(cfg.syncEnabled).toBe(false);
  });

  it("lets a repo opt out of syncing while still retargeting", () => {
    const cfg = resolveStagingConfig(PROJECT, {
      ...NO_OVERRIDES,
      stagingSyncEnabled: false,
    });
    expect(cfg.retargetEnabled).toBe(true);
    expect(cfg.syncEnabled).toBe(false);
    expect(cfg.overridden.syncEnabled).toBe(true);
  });
});
