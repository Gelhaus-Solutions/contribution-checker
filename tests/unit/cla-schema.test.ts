import { describe, expect, it } from "vitest";
import {
  signIclaSchema,
  signCclaSchema,
  collectClaCustomAnswers,
  CLA_CUSTOM_FIELD_PREFIX,
} from "@/lib/cla/schema";
import type { FormSchema } from "@/lib/applications/schema";

describe("signIclaSchema (optional signature)", () => {
  it("accepts an empty legal name (signature optional at schema level)", () => {
    const r = signIclaSchema.safeParse({
      projectId: "p1",
      legalName: "",
      agree: true,
    });
    expect(r.success).toBe(true);
  });

  it("still requires the agreement checkbox", () => {
    const r = signIclaSchema.safeParse({
      projectId: "p1",
      legalName: "Jane Doe",
      agree: false,
    });
    expect(r.success).toBe(false);
  });
});

describe("signCclaSchema (full executed block)", () => {
  const base = {
    projectId: "p1",
    agree: true,
    legalName: "Jane Q. Signatory",
    companyName: "Acme, Inc.",
    registeredAddress: "1 Example St\nSpringfield",
    country: "United States",
    contactName: "Alex Contact",
    contactEmail: "legal@acme.com",
    signatoryTitle: "VP Engineering",
    signatureText: "Jane Q. Signatory",
  };

  it("accepts a complete corporate signature block", () => {
    expect(signCclaSchema.safeParse(base).success).toBe(true);
  });

  it("requires the company, address, country, contact, title, and signature", () => {
    for (const key of [
      "companyName",
      "registeredAddress",
      "country",
      "contactName",
      "contactEmail",
      "signatoryTitle",
      "signatureText",
    ] as const) {
      const bad = { ...base, [key]: "" };
      expect(signCclaSchema.safeParse(bad).success, `missing ${key}`).toBe(false);
    }
  });

  it("requires a representative legal name (>= 2 chars)", () => {
    expect(signCclaSchema.safeParse({ ...base, legalName: "" }).success).toBe(
      false
    );
  });

  it("rejects a malformed contact email", () => {
    expect(
      signCclaSchema.safeParse({ ...base, contactEmail: "not-an-email" }).success
    ).toBe(false);
  });
});

describe("collectClaCustomAnswers", () => {
  const fields: FormSchema = [
    { id: "company", type: "text", label: "Company", required: false },
    { id: "agree_terms", type: "checkbox", label: "Agree", required: false },
  ];

  it("reads prefixed keys, coercing checkboxes to booleans", () => {
    const fd = new FormData();
    fd.set(`${CLA_CUSTOM_FIELD_PREFIX}company`, "Acme");
    fd.set(`${CLA_CUSTOM_FIELD_PREFIX}agree_terms`, "on");
    const out = collectClaCustomAnswers(fd, fields);
    expect(out).toEqual({ company: "Acme", agree_terms: true });
  });

  it("treats an absent checkbox as false and absent text as empty", () => {
    const out = collectClaCustomAnswers(new FormData(), fields);
    expect(out).toEqual({ company: "", agree_terms: false });
  });
});
