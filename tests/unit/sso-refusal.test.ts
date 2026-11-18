import { describe, expect, it } from "vitest";
import { SsoError } from "@ghub/gpsso-sdk";
import { isUnverifiedAddressRefusal } from "@/lib/sso";

// GPID's sentence for a GitHub account it can neither find nor create an
// account for (oauth.service.ts, `refused_unidentified`).
const REFUSAL =
  "this provider does not confirm an address, so it cannot find or create an account. " +
  "Sign in and add it from your settings, then it will work";

describe("isUnverifiedAddressRefusal", () => {
  it("recognizes GPID's refusal of an unverified address", () => {
    expect(isUnverifiedAddressRefusal(new SsoError(400, REFUSAL, { statusCode: 400, message: REFUSAL }))).toBe(
      true,
    );
  });

  it("leaves every other refusal to the generic notice", () => {
    expect(isUnverifiedAddressRefusal(new SsoError(400, "that account is already linked to somebody else"))).toBe(
      false,
    );
    expect(isUnverifiedAddressRefusal(new SsoError(401, "that combination did not work"))).toBe(false);
    expect(isUnverifiedAddressRefusal(new SsoError(500, REFUSAL))).toBe(false);
    expect(isUnverifiedAddressRefusal(new Error(REFUSAL))).toBe(false);
    expect(isUnverifiedAddressRefusal(undefined)).toBe(false);
  });
});
