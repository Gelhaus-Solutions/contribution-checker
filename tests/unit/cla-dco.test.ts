import { describe, expect, it } from "vitest";
import { DCO_SIGN_OFF_GUIDANCE, verifyDco } from "@/lib/cla/dco";

describe("verifyDco", () => {
  it("passes a commit with a valid Signed-off-by trailer", () => {
    const r = verifyDco([
      {
        sha: "abc123",
        message: "Fix bug\n\nSigned-off-by: Jane Doe <jane@example.com>",
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("fails a commit with no Signed-off-by trailer", () => {
    const r = verifyDco([{ sha: "deadbeef", message: "Fix bug, no sign-off" }]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      { sha: "deadbeef", reason: "missing Signed-off-by trailer" },
    ]);
  });

  it("fails a malformed trailer with no angle-bracketed email", () => {
    const r = verifyDco([
      {
        sha: "no-email",
        message: "Fix bug\n\nSigned-off-by: Jane Doe jane@example.com",
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.missing[0]?.sha).toBe("no-email");
  });

  it("fails a trailer that is missing the name", () => {
    const r = verifyDco([
      {
        sha: "no-name",
        message: "Fix bug\n\nSigned-off-by: <jane@example.com>",
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.missing[0]?.sha).toBe("no-name");
  });

  it("handles multiple commits with a mix of pass/fail", () => {
    const r = verifyDco([
      { sha: "ok1", message: "A\n\nSigned-off-by: Al <al@example.com>" },
      { sha: "bad1", message: "B (no sign-off)" },
      { sha: "ok2", message: "C\n\nSigned-off-by: Bo <bo@example.com>" },
      { sha: "bad2", message: "D\n\nSigned-off-by: malformed" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.sha)).toEqual(["bad1", "bad2"]);
  });

  it("passes a trailer authored with CRLF line endings", () => {
    const r = verifyDco([
      {
        sha: "crlf",
        message: "Fix bug\r\n\r\nSigned-off-by: Jane Doe <jane@example.com>\r\n",
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("matches a trailer that is not the last line", () => {
    const r = verifyDco([
      {
        sha: "midline",
        message:
          "Fix bug\n\nSigned-off-by: Jane Doe <jane@example.com>\nReviewed-by: Sam <sam@example.com>",
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it("returns ok for an empty commit list", () => {
    const r = verifyDco([]);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe("DCO_SIGN_OFF_GUIDANCE", () => {
  it("mentions git commit -s and the trailer format", () => {
    expect(DCO_SIGN_OFF_GUIDANCE).toContain("git commit -s");
    expect(DCO_SIGN_OFF_GUIDANCE).toContain("Signed-off-by:");
  });
});
