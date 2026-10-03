/**
 * Where an account stands with the terms it agrees to on the instance
 * Gelhaus Solutions hosts, decided from GPlatform Terms' rules.
 *
 * Two documents, both Gelhaus Solutions': Contribution Checker's own terms and
 * the general terms of service they build on. Which versions exist, when each
 * is announced and when it binds come from GPlatform Terms' signed snapshot
 * (surface `contribution-checker`), never from this repository (GPLATTERMS-43).
 * An acceptance is recorded as the archived version ids, joined with "+".
 *
 * The rule is the one every Gelhaus Solutions product follows: a new version
 * is announced by email at least six weeks before it binds, the person is
 * asked at their next sign-in and may say "not now" until it binds, and a free
 * account that has not accepted it by then can still sign in and read, and
 * nothing else, until it does. Contribution Checker is free, so nobody is
 * exempt.
 *
 * An account older than this step recorded no acceptance (the step went live
 * on 2026-10-01). It is decided as if it had accepted the versions in force
 * when the step began: asked about every newer version from its announcement,
 * restricted only once one binds (operator, 2026-10-03). No acceptance is
 * invented for it in any record.
 *
 * JSX-free and free of I/O, so the whole rule is testable under the node
 * environment; `gpterms.ts` brings the rules and the service's answer.
 */

import type { ConsentState, Terms } from "@ghub/terms-rules";

/** The GPlatform Terms surface this product asks and records against. */
export const TERMS_SURFACE = "contribution-checker";

/** The archive's frozen copies, where every recorded version can be read. */
const ARCHIVE_BASE = "https://gplatform.org/legal/";

/**
 * When this step went live on the hosted instance. An account created before
 * it that never recorded an acceptance is decided from the versions in force
 * then, not made to accept the ones it has been using the service under.
 */
export const TERMS_STEP_SINCE = new Date("2026-10-01T20:30:00Z");

/** Contribution Checker is free: nobody here pays, and there are no exempt staff. */
const HOLDER = { paid: false } as const;

/** The rules this module reads: GPlatform Terms' snapshot, bound. */
export type TermsRules = Pick<Terms, "consentStateAt" | "versionToRecord" | "documentsFor">;

/**
 * Where an account stands.
 *
 * - `off`: the step is not switched on (any instance but the one we host).
 * - `agreed`: it accepted the newest version of every document. Full use.
 * - `quiet`: an account older than this step, which never recorded an
 *   acceptance, while nothing new is announced.
 * - `first`: a new account that has accepted nothing. It accepts before it
 *   uses anything.
 * - `asked`: a newer version is announced and not yet binding. Full use; asked
 *   once per sign-in, may say "not now" until `inForceFrom`.
 * - `restricted`: a version it has not accepted binds. It may sign in and read,
 *   and nothing else, until it accepts.
 */
export type TermsKind = "off" | "agreed" | "quiet" | "first" | "asked" | "restricted";

export interface TermsStanding {
  kind: TermsKind;
  /** For `asked`, when the first version it has not accepted binds. */
  inForceFrom: Date | null;
  /** What accepting now records: the newest version of each document, joined with "+". */
  record: string;
}

/** What an account brings to the question: when it was made, and every acceptance it recorded, oldest first. */
export interface TermsAccount {
  createdAt: Date;
  accepted: readonly string[];
}

/**
 * The record the rules decide from: the account's newest acceptance, or, for
 * an account older than this step that has none, the versions in force when
 * the step began. Null for a new account that has accepted nothing.
 */
export function decidingRecord(rules: TermsRules, account: TermsAccount): string | null {
  const newest = account.accepted.at(-1) ?? null;
  if (newest !== null) return newest;
  if (account.createdAt.getTime() >= TERMS_STEP_SINCE.getTime()) return null;
  return rules.versionToRecord(TERMS_SURFACE, TERMS_STEP_SINCE);
}

function standingOf(
  state: ConsentState,
  legacy: boolean,
  record: string,
): TermsStanding {
  switch (state.kind) {
    case "asked":
      return { kind: "asked", inForceFrom: state.inForceFrom, record };
    case "restricted":
      return { kind: "restricted", inForceFrom: null, record };
    default:
      // `owed-paid` and `exempt` cannot happen for a free product with no
      // staff exemption; both mean full use, as `agreed` does.
      return { kind: legacy ? "quiet" : "agreed", inForceFrom: null, record };
  }
}

/** Where an account stands at `now`, decided here from the rules alone. */
export function standingAt(rules: TermsRules, account: TermsAccount, now: Date): TermsStanding {
  const record = rules.versionToRecord(TERMS_SURFACE, now);
  const deciding = decidingRecord(rules, account);
  if (deciding === null) return { kind: "first", inForceFrom: null, record };
  const legacy = account.accepted.length === 0;
  return standingOf(rules.consentStateAt(TERMS_SURFACE, deciding, now, HOLDER), legacy, record);
}

/**
 * The service's answer, weighed against the standing decided here. The
 * service holds the ledger, so its answer wins, except where it would take
 * more away than this product's own record does: an acceptance still in the
 * outbox, an older account the ledger holds no acceptance for (by the rule
 * above it is asked, not restricted), or a new account, which accepts first
 * whatever the ledger says.
 */
export function weighed(
  local: TermsStanding,
  answer: ConsentState,
  toRecord: string | null,
  legacy: boolean,
): TermsStanding {
  if (local.kind === "first") return local;
  if (answer.kind === "restricted" && local.kind !== "restricted") return local;
  return standingOf(answer, legacy, toRecord ?? local.record);
}

/** The documents accepting now covers, at their newest versions, with both links. */
export function documentsToAccept(rules: TermsRules, now: Date) {
  const at = now.getTime();
  return rules.documentsFor(TERMS_SURFACE, now).map((version) => {
    const inForceFrom = new Date(version.rollout.inForceFrom);
    return {
      title: version.title.en,
      version: version.version,
      liveUrl: version.liveUrl.en,
      archiveUrl: version.archiveUrl.en ?? `${ARCHIVE_BASE}${version.versionId}`,
      inForceFrom,
      inForce: inForceFrom.getTime() <= at,
    };
  });
}

/** Whether a standing refuses every write: nothing accepted yet, or behind on what binds. */
export function termsRefusesWrites(kind: TermsKind | undefined): boolean {
  return kind === "first" || kind === "restricted";
}

/** The cookie that remembers "not now" (or "continue read-only") for this browser session. */
export const TERMS_ANSWER_COOKIE = "cc_terms_answer";

/** Where the accept page sends a person back to: a local path, never another origin. */
export function safeNext(value: unknown, fallback = "/dashboard"): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : fallback;
}

/** The accept page, returning to `next` afterwards. */
export function acceptTermsPath(next = "/dashboard"): string {
  return `/accept-terms?next=${encodeURIComponent(safeNext(next))}`;
}

/** What a refused write says. */
export const TERMS_REFUSAL =
  "Accept the current terms first. Open /accept-terms, read them and accept.";
