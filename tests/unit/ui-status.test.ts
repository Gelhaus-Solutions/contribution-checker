import { describe, expect, it } from "vitest";
import {
  isKnownStatus,
  statusLabel,
  statusTone,
} from "@/lib/ui/status";

describe("statusTone", () => {
  it("maps the application lifecycle", () => {
    expect(statusTone("SUBMITTED")).toBe("warning");
    expect(statusTone("APPROVED")).toBe("success");
    expect(statusTone("DENIED")).toBe("destructive");
  });

  it("gives PENDING a tone everywhere", () => {
    // Four of the eight maps this replaces had no PENDING key, so a pending
    // applicant rendered in the same neutral grey as a revoked record.
    expect(statusTone("PENDING")).toBe("warning");
  });

  it("covers the PR check statuses, including CHECK_REQUIRED", () => {
    // PrCheck.status stores CHECK_REQUIRED, but prs-list.tsx typed PrStatus as
    // only four values and indexed its map with no fallback, so a CLA- or
    // DCO-gated PR rendered an unstyled default badge.
    expect(statusTone("BYPASSED")).toBe("success");
    expect(statusTone("CHECK_REQUIRED")).toBe("warning");
    expect(statusTone("IGNORED")).toBe("secondary");
  });

  it("covers the CLA roster and version statuses", () => {
    expect(statusTone("ACTIVE")).toBe("success");
    expect(statusTone("REVOKED")).toBe("secondary");
    expect(statusTone("DISPUTED")).toBe("destructive");
    expect(statusTone("SUPERSEDED")).toBe("secondary");
  });

  it("degrades rather than throwing on an unknown status", () => {
    expect(statusTone("SOMETHING_NEW")).toBe("secondary");
    expect(statusTone("")).toBe("secondary");
  });
});

describe("statusLabel", () => {
  it("rewrites the statuses that read badly raw", () => {
    expect(statusLabel("PENDING")).toBe("Not applied");
    expect(statusLabel("SUBMITTED")).toBe("In review");
    expect(statusLabel("CHECK_REQUIRED")).toBe("Check required");
  });

  it("sentence-cases anything it does not know", () => {
    expect(statusLabel("APPROVED")).toBe("Approved");
    expect(statusLabel("SUPERSEDED")).toBe("Superseded");
    expect(statusLabel("SOME_NEW_STATUS")).toBe("Some new status");
  });
});

describe("isKnownStatus", () => {
  it("separates known from unknown", () => {
    expect(isKnownStatus("APPROVED")).toBe(true);
    expect(isKnownStatus("CHECK_REQUIRED")).toBe(true);
    expect(isKnownStatus("NOPE")).toBe(false);
  });
});
