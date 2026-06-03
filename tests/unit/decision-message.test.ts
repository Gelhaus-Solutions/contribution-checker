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

  it("composes a PENDING (no-application) body with the apply URL and login", () => {
    const msg = buildDecisionMessage({
      decision: { status: "PENDING", reason: "no-application" },
      projectName,
      applyUrl,
      ghLogin,
    });
    expect(msg).toContain("@octocat");
    expect(msg).toContain("**Acme**");
    expect(msg).toContain(applyUrl);
    expect(msg).toContain("Please apply");
  });

  it("PENDING (submitted) tells the user the application is awaiting review", () => {
    const msg = buildDecisionMessage({
      decision: { status: "PENDING", reason: "submitted" },
      projectName,
      applyUrl,
      ghLogin,
    });
    expect(msg).toContain("@octocat");
    expect(msg).toContain("awaiting review");
    expect(msg).not.toContain("Please apply");
  });

  it("includes the cooldown date for DENIED with cooldown but never the reason", () => {
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
    // The reason is confidential; it must not appear in the PR comment.
    expect(msg).not.toContain("spam");
    // Instead the comment links to the applicant's status page to view it.
    expect(msg).toContain(applyUrl);
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
    expect(msg).toContain(applyUrl);
    expect(msg).not.toContain("re-apply");
  });
});
