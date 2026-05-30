import { describe, expect, it } from "vitest";
import { buildDecisionCheckPayload, buildClaCheckPayload } from "@/lib/github/check-run";

const applyUrl = "https://example.test/p/proj";
const projectName = "Demo";

describe("buildDecisionCheckPayload", () => {
  it("APPROVED → success", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "APPROVED" },
      applyUrl,
      projectName,
    });
    expect(p.status).toBe("completed");
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("Approved");
    expect(p.detailsUrl).toBe(applyUrl);
  });

  it("APPROVED with checker_disabled bypass reason gets a distinct title", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "APPROVED", bypassReason: "checker_disabled" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("Checker disabled");
  });

  it("BYPASSED bot → success with bot title", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "BYPASSED", reason: "bot" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("Bypassed (bot)");
  });

  it("BYPASSED collaborator → success with collaborator title", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "BYPASSED", reason: "collaborator" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("success");
    expect(p.title).toBe("Bypassed (collaborator)");
  });

  it("PENDING (no-application) → action_required, invites the user to apply", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "PENDING", reason: "no-application" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("action_required");
    expect(p.title).toBe("Application required");
    expect(p.summary).toContain("Open an application");
    expect(p.detailsUrl).toBe(applyUrl);
  });

  it("PENDING (submitted) → action_required with under-review copy", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "PENDING", reason: "submitted" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("action_required");
    expect(p.title).toBe("Application under review");
    expect(p.summary).toContain("awaiting reviewer action");
  });

  it("DENIED permanent → failure", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "DENIED", reason: "spam", cooldownUntil: null },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("failure");
    expect(p.title).toBe("Denied.");
    expect(p.summary).toContain("spam");
  });

  it("DENIED with cooldown encodes the date in the title", () => {
    const cooldownUntil = new Date("2030-01-15T00:00:00.000Z");
    const p = buildDecisionCheckPayload({
      decision: { status: "DENIED", reason: null, cooldownUntil },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("failure");
    expect(p.title).toBe("Denied until 2030-01-15.");
  });
});

describe("buildClaCheckPayload", () => {
  const claUrl = "https://example.test/p/proj/cla";

  it("required → action_required with the CLA name + details link", () => {
    const p = buildClaCheckPayload({ state: "required", projectName, claUrl });
    expect(p.name).toBe("contribution-checker / cla");
    expect(p.conclusion).toBe("action_required");
    expect(p.title).toBe("CLA required");
    expect(p.detailsUrl).toBe(claUrl);
  });

  it("stale → action_required (re-sign)", () => {
    const p = buildClaCheckPayload({ state: "stale", projectName, claUrl });
    expect(p.conclusion).toBe("action_required");
    expect(p.title).toBe("Re-sign the CLA");
  });

  it("satisfied / exempt / not_required → success", () => {
    for (const state of ["satisfied", "exempt", "not_required"] as const) {
      const p = buildClaCheckPayload({ state, projectName });
      expect(p.conclusion, state).toBe("success");
      expect(p.name).toBe("contribution-checker / cla");
    }
  });
})
