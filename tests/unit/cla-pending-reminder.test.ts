import { describe, it, expect } from "vitest";
import type { PrDecision } from "@/lib/applications/decide-pr";
import { buildDecisionMessage } from "@/lib/applications/decision-message";

// The PENDING branch of buildDecisionMessage reads only ghLogin/projectName/
// applyUrl/needsCla/claUrl, so a minimal PENDING decision is sufficient here.
const pending = { status: "PENDING" } as unknown as PrDecision;

describe("buildDecisionMessage PENDING + needsCla (option A)", () => {
  const base = {
    decision: pending,
    projectName: "Acme",
    applyUrl: "https://cc.test/p/acme",
    ghLogin: "octocat",
  };

  it("omits the CLA note by default", () => {
    const msg = buildDecisionMessage(base);
    expect(msg).toContain("Please apply at");
    expect(msg).not.toContain("https://cc.test/p/acme/cla");
    expect(msg).not.toContain("Contributor License Agreement");
  });

  it("adds the sign-the-CLA note when needsCla is set", () => {
    const msg = buildDecisionMessage({ ...base, needsCla: true });
    // Still the normal pending guidance...
    expect(msg).toContain("Please apply at");
    // ...plus the CLA heads-up pointing at the standalone signing page.
    expect(msg).toContain("Contributor License Agreement");
    expect(msg).toContain("https://cc.test/p/acme/cla");
  });

  it("does not add the CLA note to a DENIED comment even with needsCla", () => {
    const denied = {
      status: "DENIED",
      reason: "spam",
    } as unknown as PrDecision;
    const msg = buildDecisionMessage({
      ...base,
      decision: denied,
      needsCla: true,
    });
    expect(msg).not.toContain("Contributor License Agreement");
  });
});
