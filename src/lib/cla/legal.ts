import "server-only";
import { env } from "@/lib/env";
import { TERMS_SURFACE } from "@/lib/terms";
import { getSecret } from "@/lib/vault/resolver";

/**
 * GPlatform Legal's CLA API (GPLATLEGAL-61, D123), as this product calls it:
 * `/api/v1/cla/contribution-checker/projects/<project id>/...` on the Terms
 * service, with the same address and key as the terms step (`GPTERMS_URL`,
 * `GPTERMS_API_KEY`). Legal holds the records, the chain and the settings of
 * a project moved there; this product keeps the experience.
 *
 * The answers are Legal's views, in this product's words (`ICLA`, `ACTIVE`,
 * `ghLogin`); `store.ts` turns them into the row shapes the pages read.
 */

export class ClaLegalError extends Error {
  constructor(
    /** The HTTP status, or null when Legal could not be reached. */
    readonly status: number | null,
    /** Legal's refusal code (`cla.version-moved`), where it sent one. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = "ClaLegalError";
  }
}

/**
 * Legal could not answer: it was not reached, or it failed on its side (5xx).
 * A refusal (4xx) is an answer, and is not this.
 */
export function legalIsDown(error: unknown): error is ClaLegalError {
  return error instanceof ClaLegalError && (error.status === null || error.status >= 500);
}

/** What a page gets instead of its data while Legal cannot answer. */
export const LEGAL_DOWN = Symbol("legal-down");

/**
 * Runs a page's reads of a moved project, and gives LEGAL_DOWN instead of
 * throwing while Legal cannot answer, so the page can say so rather than fall
 * through to the generic error page. A refusal still throws.
 */
export async function unlessLegalDown<T>(read: () => Promise<T>): Promise<T | typeof LEGAL_DOWN> {
  try {
    return await read();
  } catch (error) {
    if (legalIsDown(error)) return LEGAL_DOWN;
    throw error;
  }
}

export type LegalKind = "ICLA" | "CCLA";

export interface LegalProjectView {
  project: string;
  currentIclaVersionId: string | null;
  currentCclaVersionId: string | null;
  minIclaVersion: number;
  minCclaVersion: number;
  chain: { entries: number; head: string | null };
}

export interface LegalVersionView {
  id: string;
  kind: LegalKind;
  version: number;
  contentHash: string;
  sourceType: "manual" | "repo_file";
  sourceRepoId: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  sourceCommitSha: string | null;
  requireResign: boolean;
  resignRequired: boolean;
  publishedBy: string | null;
  publishedAt: string;
  current: boolean;
  bodyMarkdown?: string;
}

export interface LegalSignatureView {
  id: string;
  kind: LegalKind;
  versionId: string;
  documentVersion: number;
  contentHash: string;
  userId: string | null;
  ghId: number;
  ghLogin: string;
  emailSnapshot: string | null;
  legalName: string;
  affirmation: string;
  signatureKind: "typed" | "drawn" | "uploaded" | null;
  signatureText: string | null;
  signatureImageSha256: string | null;
  signatureImage?: string | null;
  customFields: Record<string, string | boolean> | null;
  ip: string;
  userAgent: string;
  applicationId: string | null;
  status: "ACTIVE" | "REVOKED";
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  signedAt: string;
  corporateId: string | null;
  corporate: {
    id: string;
    companyName: string;
    registeredAddress: string | null;
    country: string | null;
    contactName: string | null;
    contactEmail: string;
    signatoryTitle: string | null;
  } | null;
}

export interface LegalCorporateView {
  id: string;
  versionId: string;
  signatureId: string;
  companyName: string;
  registeredAddress: string | null;
  country: string | null;
  contactName: string | null;
  contactEmail: string;
  signatoryTitle: string | null;
  signatureText: string | null;
  status: "PENDING" | "ACTIVE" | "REJECTED" | "REVOKED";
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  signatory: { userId: string | null; ghId: number; ghLogin: string; legalName: string };
  roster: Record<"ACTIVE" | "REVOKED" | "DISPUTED", number>;
}

export interface LegalRosterView {
  id: string;
  corporateId: string;
  companyName: string;
  ghLogin: string;
  ghId: number | null;
  status: "ACTIVE" | "REVOKED" | "DISPUTED";
  addedBy: string | null;
  addedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  disputedAt: string | null;
  disputeNote: string | null;
}

export interface LegalWaiverView {
  id: string;
  ghLogin: string;
  ghId: number | null;
  reason: string;
  grantedBy: string | null;
  grantedAt: string;
  status: "ACTIVE" | "REVOKED";
  revokedBy: string | null;
  revokedAt: string | null;
}

export interface LegalEventView {
  seq: number;
  kind: string;
  payload: string;
  actorUserId: string | null;
  actorGhId: number | null;
  signatureId: string | null;
  documentVersionId: string | null;
  rosterMemberId: string | null;
  corporateId: string | null;
  waiverId: string | null;
  prevHash: string;
  entryHash: string;
  createdAt: string;
  imported: boolean;
}

export interface LegalPage<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

let transport: Transport = (url, init) => fetch(url, init);
let configured: Promise<{ baseUrl: string; apiKey: string } | null> | undefined;

/** Tests only: answer Legal's requests here instead of over the network. */
export function setLegalTransportForTests(
  next: Transport | null,
  config: { baseUrl: string; apiKey: string } | null = null
): void {
  transport = next ?? ((url, init) => fetch(url, init));
  configured = next === null ? undefined : Promise.resolve(config);
}

async function config(): Promise<{ baseUrl: string; apiKey: string } | null> {
  configured ??= (async () => {
    if (!env.gptermsConfigured || env.GPTERMS_URL === undefined) return null;
    const apiKey = env.GPTERMS_API_KEY ?? (await getSecret("GPTERMS_API_KEY"));
    if (!apiKey) return null;
    return { baseUrl: env.GPTERMS_URL.replace(/\/+$/u, ""), apiKey };
  })();
  return configured;
}

/** Whether this instance can reach Legal at all: its address and key are set. */
export async function legalConfigured(): Promise<boolean> {
  return (await config()) !== null;
}

const TIMEOUT_MS = 15_000;

/**
 * One request to Legal's CLA API for a project (`path` after
 * `projects/<id>/`), or for the surface (`people`, with `project` null).
 */
export async function legal<T>(
  method: "GET" | "POST" | "PUT",
  project: string | null,
  path: string,
  body?: unknown
): Promise<T> {
  const made = await config();
  if (made === null) {
    throw new ClaLegalError(
      null,
      null,
      "GPlatform Legal is not configured here (GPTERMS_URL and GPTERMS_API_KEY), and this project's CLA records are there."
    );
  }
  const where =
    project === null
      ? `v1/cla/${TERMS_SURFACE}/${path}`
      : `v1/cla/${TERMS_SURFACE}/projects/${encodeURIComponent(project)}${path === "" ? "" : `/${path}`}`;
  let response: Response;
  try {
    response = await transport(`${made.baseUrl}/api/${where}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${made.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClaLegalError(
      null,
      null,
      `GPlatform Legal could not be reached: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    throw new ClaLegalError(
      response.status,
      null,
      `GPlatform Legal answered ${String(response.status)} with a body that is not JSON.`
    );
  }
  if (!response.ok) {
    const refusal = (parsed ?? {}) as { code?: unknown; message?: unknown };
    throw new ClaLegalError(
      response.status,
      typeof refusal.code === "string" ? refusal.code : null,
      typeof refusal.message === "string"
        ? refusal.message
        : `GPlatform Legal refused (${String(response.status)}).`
    );
  }
  return parsed as T;
}

/** Every item of a paged list, 200 at a time. */
export async function legalAll<T>(project: string, path: string, query: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = query === "" ? "" : "&";
    const answer = await legal<LegalPage<T>>(
      "GET",
      project,
      `${path}?${query}${separator}perPage=200&page=${String(page)}`
    );
    items.push(...answer.items);
    if (page >= answer.pages) return items;
  }
}
