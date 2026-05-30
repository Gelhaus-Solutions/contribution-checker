import { describe, expect, it } from "vitest";
import {
  signIclaSchema,
  signCclaSchema,
  signatureSchema,
  collectSignature,
  collectClaCustomAnswers,
  parseChainPayload,
  CLA_CUSTOM_FIELD_PREFIX,
} from "@/lib/cla/schema";
import type { FormSchema } from "@/lib/applications/schema";

// A valid 1x1 transparent PNG as a data URL.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
  };

  it("accepts a complete corporate block (signature validated separately)", () => {
    expect(signCclaSchema.safeParse(base).success).toBe(true);
  });

  it("requires the company, address, country, contact, and title", () => {
    for (const key of [
      "companyName",
      "registeredAddress",
      "country",
      "contactName",
      "contactEmail",
      "signatoryTitle",
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

describe("signatureSchema (type / draw / upload)", () => {
  it("accepts a typed signature of >= 2 chars", () => {
    expect(
      signatureSchema.safeParse({ signatureKind: "typed", signatureText: "JD" })
        .success
    ).toBe(true);
  });

  it("rejects a typed signature that is too short", () => {
    expect(
      signatureSchema.safeParse({ signatureKind: "typed", signatureText: "J" })
        .success
    ).toBe(false);
  });

  it("accepts a drawn/uploaded signature with a valid image data URL", () => {
    expect(
      signatureSchema.safeParse({
        signatureKind: "drawn",
        signatureImage: PNG_DATA_URL,
      }).success
    ).toBe(true);
    expect(
      signatureSchema.safeParse({
        signatureKind: "uploaded",
        signatureImage: PNG_DATA_URL,
      }).success
    ).toBe(true);
  });

  it("rejects a drawn signature with no image", () => {
    expect(signatureSchema.safeParse({ signatureKind: "drawn" }).success).toBe(
      false
    );
  });

  it("rejects a non-image data URL", () => {
    expect(
      signatureSchema.safeParse({
        signatureKind: "uploaded",
        signatureImage: "data:text/html;base64,PHA+aGk8L3A+",
      }).success
    ).toBe(false);
  });
});

describe("collectSignature", () => {
  it("reads the three (optionally prefixed) signature fields", () => {
    const fd = new FormData();
    fd.set("cla_signatureKind", "drawn");
    fd.set("cla_signatureImage", PNG_DATA_URL);
    const out = collectSignature(fd, "cla_");
    expect(out.signatureKind).toBe("drawn");
    expect(out.signatureImage).toBe(PNG_DATA_URL);
    expect(out.signatureText).toBe("");
  });

  it("defaults signatureKind to typed when absent", () => {
    expect(collectSignature(new FormData()).signatureKind).toBe("typed");
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

describe("parseChainPayload (ledger payloads)", () => {
  it("accepts a doc.resign_set payload", () => {
    const res = parseChainPayload(
      JSON.stringify({
        kind: "doc.resign_set",
        documentKind: "ICLA",
        versions: [
          { versionId: "v2id", version: 2, resignRequired: true },
          { versionId: "v3id", version: 3, resignRequired: true },
        ],
        setAt: "2026-06-01T00:00:00.000Z",
      })
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a doc.resign_set payload with no versions", () => {
    const res = parseChainPayload(
      JSON.stringify({
        kind: "doc.resign_set",
        documentKind: "ICLA",
        versions: [],
        setAt: "2026-06-01T00:00:00.000Z",
      })
    );
    expect(res.ok).toBe(false);
  });

  it("accepts a legacy doc.published payload without resignVersionIds", () => {
    // Historical entries (pre per-version re-sign) must still validate so
    // verifyChain re-hashes them identically.
    const res = parseChainPayload(
      JSON.stringify({
        kind: "doc.published",
        documentVersionId: "vid",
        documentKind: "ICLA",
        version: 1,
        contentHash: "abc",
        sourceType: "manual",
        requireResign: false,
        publishedAt: "2026-01-01T00:00:00.000Z",
      })
    );
    expect(res.ok).toBe(true);
  });

  it("accepts a doc.published payload carrying resignVersionIds", () => {
    const res = parseChainPayload(
      JSON.stringify({
        kind: "doc.published",
        documentVersionId: "vid",
        documentKind: "ICLA",
        version: 4,
        contentHash: "abc",
        sourceType: "manual",
        requireResign: false,
        resignVersionIds: ["v2id", "v3id"],
        publishedAt: "2026-06-01T00:00:00.000Z",
      })
    );
    expect(res.ok).toBe(true);
  });
});
