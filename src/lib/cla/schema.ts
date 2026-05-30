import { z } from "zod";

// ---------------------------------------------------------------------------
// CLA config note
//
// Unlike the application form schema, CLA configuration does NOT live in a JSON
// column: it is modeled with boolean/int/string columns on `Project`
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

// ICLA legal name is optional at the schema level: whether a typed signature is
// *required* is a per-project setting (claIclaRequireSignature), enforced in the
// signing action. Empty string is allowed here. (CCLA always requires it.)
const optionalLegalNameSchema = z
  .string()
  .trim()
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
  // May be empty when the project does not require a typed signature for ICLAs.
  legalName: z.string(),
  affirmation: z.string(),
  signatureKind: z.string().nullable().optional(),
  signatureText: z.string().nullable().optional(),
  signatureImageSha256: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
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
  signatureKind: z.string().nullable().optional(),
  signatureText: z.string().nullable().optional(),
  signatureImageSha256: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  companyName: z.string().min(1),
  registeredAddress: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  signatoryTitle: z.string().nullable().optional(),
  contactEmail: z.string().min(1),
  emailSnapshot: z.string().nullable().optional(),
  ip: z.string(),
  userAgent: z.string(),
  signedAt: z.string().min(1),
});

const cclaApprovedPayloadSchema = z.object({
  kind: z.literal("ccla.approved"),
  corporateId: z.string().min(1),
  companyName: z.string().min(1),
  approvedAt: z.string().min(1),
});

const cclaRejectedPayloadSchema = z.object({
  kind: z.literal("ccla.rejected"),
  corporateId: z.string().min(1),
  companyName: z.string().min(1),
  // May be empty when the admin rejects without a stated reason.
  reason: z.string(),
  rejectedAt: z.string().min(1),
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
  // Prior version ids marked resignRequired as part of this publish. Optional so
  // historical doc.published entries (written before per-version re-sign) still
  // validate and re-hash identically under verifyChain.
  resignVersionIds: z.array(z.string().min(1)).optional(),
  publishedAt: z.string().min(1),
});

// Retroactive per-version re-sign change on already-published versions. Records
// exactly which versions were flipped and to what, so the legal ledger shows
// "at time setAt, admin marked versions [..] as requiring (or no longer
// requiring) re-sign."
const docResignSetPayloadSchema = z.object({
  kind: z.literal("doc.resign_set"),
  documentKind: documentKindSchema,
  versions: z
    .array(
      z.object({
        versionId: z.string().min(1),
        version: z.number().int().nonnegative(),
        resignRequired: z.boolean(),
      })
    )
    .min(1),
  setAt: z.string().min(1),
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
  cclaApprovedPayloadSchema,
  cclaRejectedPayloadSchema,
  docPublishedPayloadSchema,
  docResignSetPayloadSchema,
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
  // Optional here; required-ness depends on Project.claIclaRequireSignature and
  // is enforced in the signing action.
  legalName: optionalLegalNameSchema,
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
  // CCLA always requires the authorized representative's full legal name.
  legalName: legalNameSchema,
  companyName: cclaLine(200, "company name"), // Legal Entity (full legal name)
  registeredAddress: z.string().trim().min(1).max(500), // may span lines
  country: cclaLine(100, "country"),
  contactName: cclaLine(200, "point of contact name"),
  contactEmail: z.string().trim().email().max(320),
  signatoryTitle: cclaLine(120, "title"), // representative's Title (required)
  // The signature itself (type/draw/upload) is validated separately with
  // `signatureSchema` from the SignatureInput fields.
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
  // Checkbox: present => require re-sign for ALL prior versions of this kind.
  requireResign: z.coerce.boolean(),
  // Optional granular selection: prior version ids to mark resignRequired. The
  // action validates these belong to (projectId, kind).
  resignVersionIds: z.array(z.string().min(1)).optional(),
});

// Retroactively flip resignRequired on already-published versions (the
// "v1 valid, v2+v3 stale" control and the per-version toggle in Version
// history). The action validates ownership and refuses the current version.
export const setVersionResignSchema = z.object({
  projectId: z.string().min(1),
  changes: z
    .array(
      z.object({
        versionId: z.string().min(1),
        resignRequired: z.coerce.boolean(),
      })
    )
    .min(1)
    .max(500),
});

export const approvePendingChangeSchema = z.object({
  projectId: z.string().min(1),
  pendingChangeId: z.string().min(1),
  requireResign: z.coerce.boolean(),
  resignVersionIds: z.array(z.string().min(1)).optional(),
});

export const rejectPendingChangeSchema = z.object({
  projectId: z.string().min(1),
  pendingChangeId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

export const claSettingsSchema = z.object({
  projectId: z.string().min(1),
  // Checkbox toggles: present (e.g. "1") => true, absent => false.
  claEnabled: z.string().optional(),
  claRequired: z.string().optional(),
  claCorporateEnabled: z.string().optional(),
  claCorporateRequiresApproval: z.string().optional(),
  claPlacementEmbed: z.string().optional(),
  claPlacementStandalone: z.string().optional(),
  claAutoVersionRequiresResign: z.string().optional(),
  claRepoFileReviewMode: z.string().optional(),
  claIclaRequireSignature: z.string().optional(),
  dcoEnabled: z.string().optional(),
  labelClaPending: z.string().trim().min(1).max(50).optional(),
});

export const waiverSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: ghLoginSchema,
  reason: z.string().trim().min(1).max(500),
});

// Admin saves CLA custom fields (per kind) as a JSON Field[] (same shape as the
// application form schema). The action validates `schema` with the shared
// `formSchema` validator from src/lib/applications/schema.ts.
export const saveCustomFieldsSchema = z.object({
  projectId: z.string().min(1),
  kind: documentKindSchema,
  schema: z.string(), // JSON-encoded Field[]
});

// ----- Signature capture (type / draw / upload) -----

// A drawn/uploaded signature is stored as an image data URL. Cap the length so
// a base64 payload can't bloat the row/ledger (~2 MB binary ≈ 2.7 MB base64).
const MAX_SIGNATURE_IMAGE_LEN = 2_700_000;
const signatureImageDataUrl = z
  .string()
  .refine(
    (v) =>
      /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(v) &&
      v.length <= MAX_SIGNATURE_IMAGE_LEN,
    "signature image must be a PNG/JPEG/GIF/WebP data URL under ~2 MB"
  );

export const signatureSchema = z
  .object({
    signatureKind: z.enum(["typed", "drawn", "uploaded"]),
    signatureText: z.string().trim().max(200).optional(),
    signatureImage: signatureImageDataUrl.optional(),
  })
  .refine(
    (s) =>
      s.signatureKind === "typed"
        ? !!s.signatureText && s.signatureText.length >= 2
        : !!s.signatureImage,
    { message: "Provide a signature (type, draw, or upload one)." }
  );
export type SignatureInputData = z.infer<typeof signatureSchema>;

/** Read the SignatureInput's three fields from FormData (optionally prefixed). */
export function collectSignature(
  formData: FormData,
  prefix = ""
): { signatureKind: string; signatureText: string; signatureImage: string } {
  return {
    signatureKind: String(formData.get(`${prefix}signatureKind`) ?? "typed"),
    signatureText: String(formData.get(`${prefix}signatureText`) ?? ""),
    signatureImage: String(formData.get(`${prefix}signatureImage`) ?? ""),
  };
}

// Inputs for CLA custom fields are rendered with this prefix so a CLA field set
// can be embedded alongside the application form without `name` collisions.
export const CLA_CUSTOM_FIELD_PREFIX = "clacf_";

/**
 * Collect raw answers to CLA custom fields from FormData (inputs are named
 * `${prefix}${field.id}`), keyed by field id. Mirrors `collectAnswers` in the
 * apply flow. Validate the result with `buildAnswersSchema(fields)` before use.
 */
export function collectClaCustomAnswers(
  formData: FormData,
  fields: import("@/lib/applications/schema").FormSchema,
  prefix: string = CLA_CUSTOM_FIELD_PREFIX
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const key = `${prefix}${f.id}`;
    if (f.type === "checkbox") {
      out[f.id] = formData.get(key) !== null;
    } else {
      const v = formData.get(key);
      out[f.id] = typeof v === "string" ? v : "";
    }
  }
  return out;
}

export type SignIclaInput = z.infer<typeof signIclaSchema>;
export type SignCclaInput = z.infer<typeof signCclaSchema>;
export type RosterAddInput = z.infer<typeof rosterAddSchema>;
export type RosterRevokeInput = z.infer<typeof rosterRevokeSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
export type SetVersionResignInput = z.infer<typeof setVersionResignSchema>;
export type ApprovePendingChangeInput = z.infer<typeof approvePendingChangeSchema>;
export type RejectPendingChangeInput = z.infer<typeof rejectPendingChangeSchema>;
export type ClaSettingsInput = z.infer<typeof claSettingsSchema>;
export type WaiverInput = z.infer<typeof waiverSchema>;
