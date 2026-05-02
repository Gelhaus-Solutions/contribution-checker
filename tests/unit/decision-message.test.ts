import { describe, expect, it } from "vitest";
import { buildDecisionMessage } from "@/lib/applications/decision-message";

const projectName = "Acme";
const applyUrl = "https://example.com/p/acme";
const ghLogin = "octocat";

describe("buildDecisionMessage", () => {
  it("returns null for APPROVED", () => {
    expect(
      buildDecisionMessage({
        decision: { status: "APPROVED" },
        projectName,
        applyUrl,
        ghLogin,
      })
    ).toBeNull();
  });

  it("returns null for BYPASSED", () => {
    expect(
      buildDecisionMessage({
        decision: { status: "BYPASSED", reason: "bot" },
        projectName,
        applyUrl,
        ghLogin,
      })
    ).toBeNull();
  });

  it("composes a PENDING body with the apply URL and login", () => {
    const msg = buildDecisionMessage({
      decision: { status: "PENDING" },
      projectName,
      applyUrl,
      ghLogin,
    });
    expect(msg).toContain("@octocat");
    expect(msg).toContain("**Acme**");
    expect(msg).toContain(applyUrl);
  });

  it("includes the cooldown date for DENIED with cooldown", () => {
    const cooldownUntil = new Date("2030-04-15T12:00:00Z");
    const msg = buildDecisionMessage({
      decision: {
        status: "DENIED",
        reason: "spam",
        cooldownUntil,
      },
      projectName,
      applyUrl,
      ghLogin,
    });
    expect(msg).toContain("spam");
    expect(msg).toContain("2030-04-15");
    expect(msg).toContain("re-apply");
  });

  it("falls back to admin contact for DENIED without cooldown", () => {
    const msg = buildDecisionMessage({
      decision: { status: "DENIED", reason: null, cooldownUntil: null },
      projectName,
      applyUrl,
      ghLogin,
    });
    expect(msg).toContain("project admin");
    expect(msg).not.toContain("re-apply");
  });
});
