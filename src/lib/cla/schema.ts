import { z } from "zod";

// ---------------------------------------------------------------------------
// CLA config note
//
// Unlike the application form schema, CLA configuration does NOT live in a JSON
// column — it is modeled with boolean/int/string columns on `Project`
// (claEnabled, claRequired, claCorporateEnabled, claPlacementEmbed,
// claPlacementStandalone, labelClaPending, minIclaVersion, minCclaVersion,
// currentIclaVersionId, currentCclaVersionId, claAutoVersionRequiresResign,
// dcoEnabled, applicationRequired). So there is no `parseClaConfig` helper here.
//
// What lives here:
//  - the hash-chained ledger payload schema (`chainPayloadSchema` /
//    `parseChainPayload`), the only JSON-as-string column in the CLA feature.
//  - server-action input validators, following the patterns in
//    `src/lib/applications/schema.ts` and the checkbox FormData handling in
//    `src/app/dashboard/projects/[id]/settings/actions.ts`.
// ---------------------------------------------------------------------------

// GitHub login: 1..39 chars (GitHub's hard limit on usernames).
const ghLoginSchema = z.string().trim().min(1).max(39);

const legalNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .refine((v) => !/[\r\n]/.test(v), "legal name cannot contain line breaks");

const documentKindSchema = z.enum(["ICLA", "CCLA"]);

// ----- Hash-chained ledger payloads (`ClaEventLog.payload`) -----
//
// Each entry's payload is a canonical (key-sorted) JSON snapshot of the
// legally-relevant state at append time. The discriminant is `kind`, mirroring
// `ChainKind` in `src/lib/cla/integrity.ts`. Validated on read via
// `parseChainPayload`; written by `appendClaEvent`.

const genesisPayloadSchema = z.object({
  kind: z.literal("genesis"),
  projectId: z.string().min(1),
});

const iclaSignedPayloadSchema = z.object({
  kind: z.literal("icla.signed"),
  signatureId: z.string().min(1),
  versionId: z.string().min(1),
  documentVersion: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  ghId: z.number().int(),
  ghLogin: z.string().min(1),
  legalName: z.string().min(1),
  affirmation: z.string(),
  emailSnapshot: z.string().nullable().optional(),
  applicationId: z.string().nullable().optional(),
  ip: z.string(),
  userAgent: z.string(),
  signedAt: z.string().min(1),
});

const cclaSignedPayloadSchema = z.object({
  kind: z.literal("ccla.signed"),
  corporateId: z.string().min(1),
  signatureId: z.string().min(1),
  versionId: z.string().min(1),
  documentVersion: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  ghId: z.number().int(),
  ghLogin: z.string().min(1),
  legalName: z.string().min(1),
  affirmation: z.string(),
  companyName: z.string().min(1),
  registeredAddress: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  signatoryTitle: z.string().nullable().optional(),
  signatureText: z.string().nullable().optional(),
  contactEmail: z.string().min(1),
  emailSnapshot: z.string().nullable().optional(),
  ip: z.string(),
  userAgent: z.string(),
  signedAt: z.string().min(1),
});

const docPublishedPayloadSchema = z.object({
  kind: z.literal("doc.published"),
  documentVersionId: z.string().min(1),
  documentKind: documentKindSchema,
  version: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  sourceType: z.enum(["manual", "repo_file"]),
  sourceRepoId: z.string().nullable().optional(),
  sourcePath: z.string().nullable().optional(),
  sourceRef: z.string().nullable().optional(),
  sourceCommitSha: z.string().nullable().optional(),
  requireResign: z.boolean(),
  publishedAt: z.string().min(1),
});

const rosterAddedPayloadSchema = z.object({
  kind: z.literal("roster.added"),
  rosterMemberId: z.string().min(1),
  corporateId: z.string().min(1),
  ghLogin: z.string().min(1),
  ghId: z.number().int().nullable().optional(),
  addedAt: z.string().min(1),
});

const rosterRevokedPayloadSchema = z.object({
  kind: z.literal("roster.revoked"),
  rosterMemberId: z.string().min(1),
  corporateId: z.string().min(1),
  ghLogin: z.string().min(1),
  ghId: z.number().int().nullable().optional(),
  revokedAt: z.string().min(1),
});

const rosterDisputedPayloadSchema = z.object({
  kind: z.literal("roster.disputed"),
  rosterMemberId: z.string().min(1),
  corporateId: z.string().min(1),
  ghLogin: z.string().min(1),
  ghId: z.number().int().nullable().optional(),
  disputeNote: z.string().nullable().optional(),
  disputedAt: z.string().min(1),
});

const signatureRevokedPayloadSchema = z.object({
  kind: z.literal("signature.revoked"),
  signatureId: z.string().min(1),
  ghId: z.number().int(),
  ghLogin: z.string().min(1),
  reason: z.string(),
  revokedAt: z.string().min(1),
});

const waiverGrantedPayloadSchema = z.object({
  kind: z.literal("waiver.granted"),
  waiverId: z.string().min(1),
  ghLogin: z.string().min(1),
  ghId: z.number().int().nullable().optional(),
  reason: z.string(),
  grantedAt: z.string().min(1),
});

const waiverRevokedPayloadSchema = z.object({
  kind: z.literal("waiver.revoked"),
  waiverId: z.string().min(1),
  ghLogin: z.string().min(1),
  ghId: z.number().int().nullable().optional(),
  revokedAt: z.string().min(1),
});

export const chainPayloadSchema = z.discriminatedUnion("kind", [
  genesisPayloadSchema,
  iclaSignedPayloadSchema,
  cclaSignedPayloadSchema,
  docPublishedPayloadSchema,
  rosterAddedPayloadSchema,
  rosterRevokedPayloadSchema,
  rosterDisputedPayloadSchema,
  signatureRevokedPayloadSchema,
  waiverGrantedPayloadSchema,
  waiverRevokedPayloadSchema,
]);

export type ChainPayload = z.infer<typeof chainPayloadSchema>;

export type ParseChainPayloadResult =
  | { ok: true; payload: ChainPayload }
  | { ok: false; error: string };

/**
 * Safe-parse a `ClaEventLog.payload` JSON string. Never `JSON.parse`-and-trust;
 * callers must check `ok` before using the payload.
 */
export function parseChainPayload(json: string): ParseChainPayloadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "payload is not valid JSON" };
  }
  const parsed = chainPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, payload: parsed.data };
}

// ----- Server-action input validators -----
//
// Checkbox FormData fields use `z.string().optional()` and are coerced with
// `!!parsed.field` in the action, mirroring `updateGatingSettings`
// (value present, e.g. "1" => true; absent => false).

export const signIclaSchema = z.object({
  projectId: z.string().min(1),
  legalName: legalNameSchema,
  agree: z.literal(true),
  applicationId: z.string().min(1).optional(),
});

const cclaLine = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\r\n]/.test(v), `${label} cannot contain line breaks`);

// Full executed corporate-signature block (legally binding). legalName (from
// signIclaSchema) is the Authorized representative (name); the signing Date is
// the server-stamped signedAt, so it is not collected from the client.
export const signCclaSchema = signIclaSchema.extend({
  companyName: cclaLine(200, "company name"), // Legal Entity (full legal name)
  registeredAddress: z.string().trim().min(1).max(500), // may span lines
  country: cclaLine(100, "country"),
  contactName: cclaLine(200, "point of contact name"),
  contactEmail: z.string().trim().email().max(320),
  signatoryTitle: cclaLine(120, "title"), // representative's Title (required)
  signatureText: cclaLine(200, "signature"), // typed signature
});

export const rosterAddSchema = z.object({
  corporateId: z.string().min(1),
  ghLogins: z.array(ghLoginSchema).min(1).max(500),
});

export const rosterRevokeSchema = z.object({
  corporateId: z.string().min(1),
  memberId: z.string().min(1),
});

export const disputeSchema = z.object({
  memberId: z.string().min(1),
});

export const publishVersionSchema = z.object({
  projectId: z.string().min(1),
  kind: documentKindSchema,
  sourceType: z.enum(["manual", "repo_file"]),
  bodyMarkdown: z.string().max(100000).optional(),
  sourceRepoId: z.string().min(1).optional(),
  sourcePath: z.string().min(1).max(500).optional(),
  sourceRef: z.string().min(1).max(255).optional(),
  // Checkbox: present => require re-sign.
  requireResign: z.coerce.boolean(),
});

export const claSettingsSchema = z.object({
  projectId: z.string().min(1),
  // Checkbox toggles — present (e.g. "1") => true, absent => false.
  claEnabled: z.string().optional(),
  claRequired: z.string().optional(),
  claCorporateEnabled: z.string().optional(),
  claPlacementEmbed: z.string().optional(),
  claPlacementStandalone: z.string().optional(),
  claAutoVersionRequiresResign: z.string().optional(),
  dcoEnabled: z.string().optional(),
  labelClaPending: z.string().trim().min(1).max(50).optional(),
});

export const waiverSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: ghLoginSchema,
  reason: z.string().trim().min(1).max(500),
});

export type SignIclaInput = z.infer<typeof signIclaSchema>;
export type SignCclaInput = z.infer<typeof signCclaSchema>;
export type RosterAddInput = z.infer<typeof rosterAddSchema>;
export type RosterRevokeInput = z.infer<typeof rosterRevokeSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
export type ClaSettingsInput = z.infer<typeof claSettingsSchema>;
export type WaiverInput = z.infer<typeof waiverSchema>;
