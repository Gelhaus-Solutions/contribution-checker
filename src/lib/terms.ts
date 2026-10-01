/**
 * The terms an account agrees to on the instance Gelhaus Solutions hosts, and
 * where an account stands with them at an instant.
 *
 * Two documents, both Gelhaus Solutions': Contribution Checker's own terms and
 * the general terms of service they build on. What an account accepted is
 * recorded as their archived version ids at gplatform.org/legal, joined with
 * "+", never as a live URL: the live page changes, the archived copy cannot.
 *
 * The rule is the one every Gelhaus Solutions product follows (operator,
 * 2026-10-01): a new version is announced by email at least six weeks before
 * it binds, the person is asked to accept it at their next sign-in and may say
 * "not now" until it binds, and a free account that has not accepted it by then
 * can still sign in and read, and nothing else, until it does. Contribution
 * Checker is free, so nobody here is exempt from that last step.
 *
 * GPlatform Terms will take this over. Until then the versions live here, and
 * the dates of a new version come from the environment, so they can be set on
 * the day its notice goes out without a release.
 *
 * JSX-free and free of I/O, so the whole rule is testable under the node
 * environment.
 */

const ARCHIVE_BASE = "https://gplatform.org/legal/";

export const CC_TERMS = "project:contribution-checker:terms";
export const GENERAL_TERMS = "page:gs:terms";

/** A document an account agrees to, in the order an agreement records them. */
export interface TermsDocument {
  key: string;
  title: string;
  liveUrl: string;
}

export const TERMS_DOCUMENTS: readonly TermsDocument[] = [
  {
    key: CC_TERMS,
    title: "Contribution Checker terms",
    liveUrl: "https://gplatform.org/apps/contribution-checker/terms",
  },
  {
    key: GENERAL_TERMS,
    title: "General terms of service",
    liveUrl: "https://gplatform.org/terms",
  },
];

/** One archived version of one document, and when it is announced and binds. */
export interface TermsVersion {
  document: string;
  versionId: string;
  version: string;
  /** Null while no notice has been set for it: nobody is asked about it yet. */
  announcedAt: Date | null;
  inForceFrom: Date | null;
}

/** A new version's two dates, both set or neither. */
export interface Rollout {
  announcedAt: Date;
  inForceFrom: Date;
}

/**
 * When this step went live on the hosted instance. An account created before
 * it that never recorded an acceptance is `quiet`, not `first`: it is asked
 * about the next version rather than made to accept the ones it has been
 * using the service under.
 */
export const TERMS_STEP_SINCE = new Date("2026-10-01T20:30:00Z");

/** The freeze of the versions in force before the first rollout; they bound from it. */
const FROZEN_2026_09_06 = new Date("2026-09-06T18:40:41Z");

/**
 * Every version an agreement here can name. The 2026-10-01 versions take the
 * dates of their rollout, which the environment sets when their notice mail is
 * sent (`TERMS_2026_10_01_ANNOUNCED_AT`, `TERMS_2026_10_01_IN_FORCE_FROM`).
 */
export function termsVersions(rollout: Rollout | null): TermsVersion[] {
  const next = {
    announcedAt: rollout?.announcedAt ?? null,
    inForceFrom: rollout?.inForceFrom ?? null,
  };
  const bound = { announcedAt: FROZEN_2026_09_06, inForceFrom: FROZEN_2026_09_06 };
  return [
    { document: CC_TERMS, versionId: "contribution-checker-terms-2026-09-06", version: "2026-09-06", ...bound },
    { document: CC_TERMS, versionId: "contribution-checker-terms-2026-10-01", version: "2026-10-01", ...next },
    { document: GENERAL_TERMS, versionId: "gs-terms-2026-09-06", version: "2026-09-06", ...bound },
    { document: GENERAL_TERMS, versionId: "gs-terms-2026-10-01", version: "2026-10-01", ...next },
  ];
}

/** Six weeks and a day: the notice job may send a day after the announcement. */
export const MIN_NOTICE_MS = 43 * 24 * 60 * 60 * 1000;

/**
 * The rollout the environment names, or null when it names none. Refuses one
 * date without the other and a notice shorter than six weeks and a day, so a
 * typo cannot bind anybody early.
 */
export function rolloutFrom(
  announcedAt: string | undefined,
  inForceFrom: string | undefined,
): Rollout | null {
  if (announcedAt === undefined && inForceFrom === undefined) return null;
  if (announcedAt === undefined || inForceFrom === undefined) {
    throw new Error(
      "TERMS_2026_10_01_ANNOUNCED_AT and TERMS_2026_10_01_IN_FORCE_FROM are set together or not at all",
    );
  }
  const rollout = { announcedAt: new Date(announcedAt), inForceFrom: new Date(inForceFrom) };
  if (rollout.inForceFrom.getTime() - rollout.announcedAt.getTime() < MIN_NOTICE_MS) {
    throw new Error(
      "TERMS_2026_10_01_IN_FORCE_FROM must be at least six weeks and a day after TERMS_2026_10_01_ANNOUNCED_AT",
    );
  }
  return rollout;
}

/**
 * Where an account stands.
 *
 * - `off`: the step is not switched on (any instance but the one we host).
 * - `agreed`: it accepted the newest version of every document. Full use.
 * - `quiet`: an account older than this step, which never recorded an
 *   acceptance, while nothing new is announced. It is not asked about the
 *   versions it has used the service under; it is asked about the next one.
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

/** One document's versions at `now`, by their dates, never by list order. */
function placed(versions: readonly TermsVersion[], key: string, now: number) {
  const all = versions
    .filter((v) => v.document === key && v.announcedAt !== null && v.inForceFrom !== null)
    .sort((a, b) => a.inForceFrom!.getTime() - b.inForceFrom!.getTime());
  let inForce = -1;
  let announced = -1;
  all.forEach((v, i) => {
    if (v.inForceFrom!.getTime() <= now) inForce = i;
    else if (v.announcedAt!.getTime() <= now) announced = i;
  });
  return { all, inForce, newest: announced >= 0 ? announced : inForce };
}

export function standingAt(args: {
  now: Date;
  /** When the account was created. */
  createdAt: Date;
  /** When this step went live: older accounts with no record are `quiet`, not `first`. */
  stepSince: Date;
  /** Every recorded acceptance of the account, oldest first. */
  accepted: readonly string[];
  versions: readonly TermsVersion[];
}): TermsStanding {
  const now = args.now.getTime();
  const docs = TERMS_DOCUMENTS.map((d) => placed(args.versions, d.key, now));
  const record = docs.map((d) => d.all[d.newest]?.versionId ?? "").join("+");
  const ids = new Set(args.accepted.flatMap((r) => r.split("+")));

  if (ids.size === 0 && args.createdAt.getTime() >= args.stepSince.getTime()) {
    return { kind: "first", inForceFrom: null, record };
  }
  // An older account that never recorded anything stands where the versions in
  // force when this step began leave it: no acceptance is invented for it, it
  // is simply not asked about them.
  const legacy = ids.size === 0;
  const stepSince = args.stepSince.getTime();

  let behind = false;
  let acceptBy: number | null = null;
  for (const doc of docs) {
    let rank = -1;
    if (legacy) {
      doc.all.forEach((v, i) => {
        if (v.inForceFrom!.getTime() <= stepSince) rank = i;
      });
    } else {
      doc.all.forEach((v, i) => {
        if (ids.has(v.versionId)) rank = i;
      });
    }
    if (rank < doc.inForce) {
      behind = true;
    } else if (rank < doc.newest) {
      const from = doc.all[rank + 1]!.inForceFrom!.getTime();
      acceptBy = acceptBy === null ? from : Math.min(acceptBy, from);
    }
  }

  if (behind) return { kind: "restricted", inForceFrom: null, record };
  if (acceptBy !== null) return { kind: "asked", inForceFrom: new Date(acceptBy), record };
  return { kind: legacy ? "quiet" : "agreed", inForceFrom: null, record };
}

/** The documents accepting now covers, at their newest versions, with both links. */
export function documentsToAccept(versions: readonly TermsVersion[], now: Date) {
  const at = now.getTime();
  return TERMS_DOCUMENTS.map((doc) => {
    const { all, newest } = placed(versions, doc.key, at);
    const v = all[newest]!;
    return {
      title: doc.title,
      version: v.version,
      liveUrl: doc.liveUrl,
      archiveUrl: `${ARCHIVE_BASE}${v.versionId}`,
      inForceFrom: v.inForceFrom!,
      inForce: v.inForceFrom!.getTime() <= at,
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
