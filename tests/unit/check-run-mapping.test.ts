import { describe, expect, it } from "vitest";
import { buildDecisionCheckPayload } from "@/lib/github/check-run";

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

  it("PENDING → action_required, details points at apply URL", () => {
    const p = buildDecisionCheckPayload({
      decision: { status: "PENDING" },
      applyUrl,
      projectName,
    });
    expect(p.conclusion).toBe("action_required");
    expect(p.title).toContain("Application required");
    expect(p.detailsUrl).toBe(applyUrl);
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
