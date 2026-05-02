import { describe, expect, it } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function verify(secret: string, body: string, signature: string): boolean {
  const expected = sign(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

describe("HMAC webhook signing", () => {
  it("round-trips", () => {
    const secret = "shh-its-a-secret";
    const body = JSON.stringify({ hello: "world" });
    const sig = sign(secret, body);
    expect(verify(secret, body, sig)).toBe(true);
  });

  it("rejects mismatched signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = sign("secret-a", body);
    expect(verify("secret-b", body, sig)).toBe(false);
  });

  it("rejects modified bodies", () => {
    const secret = "secret";
    const sig = sign(secret, "original");
    expect(verify(secret, "tampered", sig)).toBe(false);
  });
});
