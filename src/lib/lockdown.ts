import "server-only";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  GlockdownStage,
  Honeytokens,
  STAGES,
  askStage,
  escalate,
  isStage,
  refusesEveryCredential,
  reportDecoys,
  signal,
  spkiPin,
  stageRank,
  strictest,
  type EdgeConnection,
  type EscalateResult,
  type HoneytokenSignal,
  type Stage,
  type StageReading,
  type StageSource,
} from "@ghub/glockdown-sdk";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * GLockdown's kill switch for this app, in five stages, each refusing what the
 * one before refused and more:
 *
 * - `off`: nothing.
 * - `signups`: no new accounts. Everyone who has one signs in as usual.
 * - `members`: only super-admins and project members (OWNER, ADMIN,
 *   REVIEWER) sign in; applicants are refused.
 * - `admins`: only super-admins.
 * - `full`: nobody, existing sessions included, and the sign-in pages send
 *   people to the lockdown page.
 *
 * From AAL phase 1 GLockdown's own rule is that every credential is refused,
 * sessions included (`refusesEveryCredential`); the agent writes `full` there,
 * and this app's `full` already refuses sessions. From AAL phase 2 the bot
 * stops too: the GitHub webhook and the CI check answer 503, so no pull request
 * is gated or touched while it holds. Below that, GitHub's signed webhooks, the
 * CI check (OIDC) and the public pages work at every stage, so pull requests
 * are not left stuck.
 *
 * The stage is the STRICTEST of three sources, and none can lower another:
 * `CC_LOCKDOWN` in the environment (a floor nothing in the app lowers), the
 * stage file the GLockdown agent on this host writes
 * (`/run/glockdown/apps/contribution-checker.json`, mounted read-only), and
 * GLockdown's edge, asked over this app's own pinned TLS identity
 * (`@ghub/glockdown-sdk`). The file and the edge each keep their last good
 * answer while silent, so a file deleted, blocked or rewritten on the host does
 * not unlock the app while the edge still says otherwise.
 *
 * Beside reading its stage, the app takes part in GLockdown three more ways,
 * all through this module and all over the same identity:
 *
 * - It can RAISE itself one rung (`raiseOneRung`, L8), from the console at
 *   /admin/lockdown or `node dist/glockdown.mjs escalate`. Nothing here can
 *   lower anything; lowering is GLockdown's.
 * - It keeps HONEYTOKENS (L97): a decoy admin's sign-in names and the SHA-256
 *   of a decoy API key. `auth()` checks the signed-in identity before it is
 *   resolved, and every API route checks the keys a request presents
 *   (`presentsDecoyKey`). A hit is refused exactly as an unknown account or
 *   key would be, and GLockdown is told (`signal`), which raises AAL phase 1.
 * - It REPORTS its decoys (L120), as hashes only, at start and once a day, so
 *   GLockdown can tell when a decoy in its inventory is no longer checked here.
 *   An empty set is reported too: that is exactly the case worth catching.
 *
 * Who may sign in is decided in `auth()` (src/auth.ts), where every session is
 * resolved; `requireSession()` sends a person the switch refused to /lockdown
 * instead of back to the sign-in loop.
 */

/** This app's name in GLockdown's scopes and the agent's configuration. */
export const GLOCKDOWN_APP = "contribution-checker";

export { STAGES, type Stage, type StageReading, type StageSource };

/**
 * GLockdown's whole ladder for an app: the five stages, then the AAL phases
 * above them, all of which the agent writes as `full`. The SDK keeps its copy
 * private; this one is for naming the rung a raise would ask for.
 */
export const RUNGS = [...STAGES, "aal", "aal2", "sil", "ail"] as const;
export type Rung = (typeof RUNGS)[number];

/** An app raises only itself, one rung per call, up to AAL (L8). */
const RAISE_CEILING: Rung = "aal";

/** From AAL phase 2 the bot stops too. */
const BOT_STOPS = new Set<string>(["aal2", "sil", "ail"]);

export function isRung(v: unknown): v is Rung {
  return typeof v === "string" && (RUNGS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// The edge and this app's identity

interface Edge {
  connection: EdgeConnection | null;
  /** Why the edge is not asked, when it is not. */
  problem: string | null;
}

let edgeState: Edge | null = null;

/**
 * Where GLockdown's edge is and who this app is, read once per process. The
 * identity is mounted before the app starts: a stage source rebuilt later to
 * pick it up would forget the last good answer it holds, which is the one
 * thing it must never do, so a late mount takes effect on the next restart.
 */
function edge(): Edge {
  if (edgeState) return edgeState;
  if (!env.GLOCKDOWN_EDGE_URL || env.glockdownEdgePins.length === 0) {
    edgeState = {
      connection: null,
      problem: "GLOCKDOWN_EDGE_URL and GLOCKDOWN_EDGE_PINS are not set",
    };
    return edgeState;
  }
  try {
    edgeState = {
      connection: {
        url: env.GLOCKDOWN_EDGE_URL,
        edgePins: env.glockdownEdgePins,
        cert: readFileSync(join(env.GLOCKDOWN_IDENTITY_DIR, "tls.crt"), "utf8"),
        key: readFileSync(join(env.GLOCKDOWN_IDENTITY_DIR, "tls.key"), "utf8"),
      },
      problem: null,
    };
  } catch (e) {
    // The file still counts; the edge is asked once the identity is mounted
    // and the app restarted.
    logger.warn(
      { err: e },
      "lockdown: no GLockdown identity, the edge is not asked",
    );
    edgeState = {
      connection: null,
      problem: `no tls.crt and tls.key in ${env.GLOCKDOWN_IDENTITY_DIR}`,
    };
  }
  return edgeState;
}

function notConfigured(problem: string | null): EscalateResult {
  return {
    ok: false,
    status: 0,
    code: "not_configured",
    detail: problem ?? "GLockdown's edge is not configured",
  };
}

// ---------------------------------------------------------------------------
// The stage

let source: GlockdownStage | null = null;

function glockdown(): GlockdownStage {
  if (source) return source;
  const { connection } = edge();
  source = new GlockdownStage({
    app: GLOCKDOWN_APP,
    dir: env.GLOCKDOWN_STAGE_DIR,
    ...(connection ? { edge: connection } : {}),
  });
  return source;
}

export interface Lockdown {
  stage: Stage;
  /** GLockdown's rung behind it (`aal`, `aal2`...), when GLockdown set it. */
  rung: string | null;
  /** AAL phase 1 and up: every credential is refused, sessions included. */
  refusesEveryCredential: boolean;
}

/** The stage now; cheap enough for every request. */
export function lockdown(): Lockdown {
  const r = glockdown().reading();
  return {
    stage: strictest(r.stage, env.CC_LOCKDOWN),
    rung: r.rung,
    refusesEveryCredential: refusesEveryCredential(r),
  };
}

/** Whether the bot stops: GitHub's webhook and the CI check answer 503 (AAL phase 2 and up). */
export function botStopped(): boolean {
  const { rung } = lockdown();
  return rung !== null && BOT_STOPS.has(rung);
}

/**
 * Whether signing in is closed to everyone, so a refused person is sent to the
 * lockdown page rather than to a sign-in page that would only refuse again.
 */
export function signInClosed(): boolean {
  const l = lockdown();
  return l.stage === "full" || l.refusesEveryCredential;
}

/** The rung GLockdown holds for this app: its own, or the stage it read when it named none. */
export function currentRung(reading: Pick<StageReading, "stage" | "rung">): Rung {
  return isRung(reading.rung) ? reading.rung : reading.stage;
}

/** The rung one raise from here would ask GLockdown for; null at the ceiling an app may reach. */
export function nextRung(reading: Pick<StageReading, "stage" | "rung">): Rung | null {
  const i = RUNGS.indexOf(currentRung(reading));
  return i < RUNGS.indexOf(RAISE_CEILING) ? RUNGS[i + 1] : null;
}

/**
 * Asks the edge again now, so a raise shows in the stage in force at once
 * rather than at the next background ask (every 15 seconds). Never throws.
 */
export function refreshFromEdge(): Promise<void> {
  return glockdown().askEdge();
}

/** The stage as a status string for `<StatusBadge>` (src/lib/ui/status.ts). */
export function stageStatus(stage: Stage): string {
  return `LOCKDOWN_${stage.toUpperCase()}`;
}

/** In plain words, per stage: what this app refuses, and what the lockdown page tells a visitor. */
export const STAGE_COPY: Record<Stage, { refuses: string; headline: string; explain: string }> = {
  off: {
    refuses: "Nothing. Everyone signs in as usual.",
    headline: "No lockdown is in force",
    explain: "Everyone signs in as usual.",
  },
  signups: {
    refuses: "New accounts. Everyone who has one signs in as usual.",
    headline: "New sign-ups are paused",
    explain:
      "If you already have an account, sign in as usual. New accounts cannot be created for now, so applying to a project waits until this lifts.",
  },
  members: {
    refuses:
      "Everyone but instance administrators and project members (owners, admins, reviewers). Applicants cannot sign in.",
    headline: "Only project members can sign in right now",
    explain:
      "Maintainers and reviewers of a project sign in as usual. Applicants cannot sign in for now; an application waits until this lifts.",
  },
  admins: {
    refuses: "Everyone but instance administrators.",
    headline: "Only administrators can sign in right now",
    explain: "This instance's administrators sign in; everyone else waits until this lifts.",
  },
  full: {
    refuses: "Everyone, existing sessions included. The sign-in pages are closed.",
    headline: "Signing in is paused",
    explain: "Nobody can sign in for now, and existing sessions are paused too.",
  },
};

/** Where a reading came from, as the console names it. */
export const SOURCE_COPY: Record<StageSource, string> = {
  file: "The agent's stage file.",
  absent:
    "No stage file and none ever read: the agent is not installed on this host yet, so sign-in stays as it was.",
  held: "The last good stage file. The file cannot be read now, and silence changes nothing.",
  unreadable:
    "A stage file that cannot be read or parsed, before any good read. A broken switch locks more, never less.",
  edge: "GLockdown's edge, whose answer is stricter than the agent's file.",
};

// ---------------------------------------------------------------------------
// The console's view

export interface LockdownStatus {
  app: string;
  stage: Stage;
  /** What holds the stage in force. */
  heldBy: "nothing" | "floor" | "glockdown" | "both";
  floor: Stage;
  /** The stricter of the agent's file and the edge's last good answer. */
  reading: StageReading;
  stageFile: string;
  botStopped: boolean;
  refusesEveryCredential: boolean;
  /** GLockdown's rung now, and the one a raise would ask for (null at the ceiling). */
  rung: Rung;
  next: Rung | null;
  edge: { url: string | null; asked: boolean; problem: string | null };
  decoys: { logins: number; keys: number };
}

export function lockdownStatus(): LockdownStatus {
  const reading = glockdown().reading();
  const floor = env.CC_LOCKDOWN;
  const stage = strictest(reading.stage, floor);
  const d = stageRank(floor) - stageRank(reading.stage);
  const { connection, problem } = edge();
  return {
    app: GLOCKDOWN_APP,
    stage,
    heldBy:
      stage === "off" ? "nothing"
      : d === 0 ? "both"
      : d > 0 ? "floor"
      : "glockdown",
    floor,
    reading,
    stageFile: join(env.GLOCKDOWN_STAGE_DIR, `${GLOCKDOWN_APP}.json`),
    botStopped: reading.rung !== null && BOT_STOPS.has(reading.rung),
    refusesEveryCredential: refusesEveryCredential(reading),
    rung: currentRung(reading),
    next: nextRung(reading),
    edge: { url: env.GLOCKDOWN_EDGE_URL ?? null, asked: !!connection, problem },
    decoys: {
      logins: env.glockdownDecoyLogins.length,
      keys: env.glockdownDecoyKeys.length,
    },
  };
}

const edgeAnswerSchema = z.object({
  app: z.literal(GLOCKDOWN_APP),
  stage: z.custom<Stage>(isStage),
  rung: z.string(),
  at: z.number().int(),
});

export type EdgeAnswer =
  | { asked: false; problem: string }
  | { asked: true; ok: true; stage: Stage; rung: string; at: number }
  | { asked: true; ok: false; status: number; code: string; detail: string | null };

/**
 * The edge's answer now, asked directly (`askStage`) with a short timeout so a
 * silent edge costs the console seconds, not a hung page. The background ask
 * runs beside it, so the stage in force takes the same answer.
 */
export async function askEdgeNow(timeoutMs = 4000): Promise<EdgeAnswer> {
  const { connection, problem } = edge();
  if (!connection) return { asked: false, problem: problem ?? "not configured" };
  void glockdown().askEdge();
  const r = await askStage({ ...connection, timeoutMs });
  if (!r.ok) {
    return { asked: true, ok: false, status: r.status, code: r.code, detail: r.detail ?? null };
  }
  const parsed = edgeAnswerSchema.safeParse(r.body);
  if (!parsed.success) {
    return {
      asked: true,
      ok: false,
      status: 200,
      code: "unexpected_answer",
      detail: "the edge answered with something that is not this app's stage",
    };
  }
  return { asked: true, ok: true, ...parsed.data };
}

export interface IdentityReport {
  dir: string;
  certificate: {
    subject: string;
    issuer: string;
    validFrom: Date;
    validTo: Date;
    /** The SHA-256 SPKI pin the operator's trust document must list for this app. */
    pin: string;
    key: "matches" | "mismatch" | "missing";
  } | null;
  problem: string | null;
  /** The edge's pins as configured; a SHA-256 pin is 43 base64url characters. */
  edgePins: { pin: string; wellFormed: boolean }[];
}

/** This app's TLS identity as the trust document sees it. Reads the mounted files; never shows the key. */
export function inspectIdentity(): IdentityReport {
  const dir = env.GLOCKDOWN_IDENTITY_DIR;
  const edgePins = env.glockdownEdgePins.map((pin) => ({
    pin,
    wellFormed: /^[A-Za-z0-9_-]{43}$/.test(pin),
  }));
  let pem: string;
  try {
    pem = readFileSync(join(dir, "tls.crt"), "utf8");
  } catch {
    return { dir, certificate: null, problem: `no tls.crt in ${dir}`, edgePins };
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return { dir, certificate: null, problem: "tls.crt is not a PEM certificate", edgePins };
  }
  let key: "matches" | "mismatch" | "missing";
  try {
    key = cert.checkPrivateKey(createPrivateKey(readFileSync(join(dir, "tls.key"), "utf8")))
      ? "matches"
      : "mismatch";
  } catch {
    key = "missing";
  }
  return {
    dir,
    certificate: {
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: new Date(cert.validFrom),
      validTo: new Date(cert.validTo),
      pin: spkiPin(pem),
      key,
    },
    problem: null,
    edgePins,
  };
}

// ---------------------------------------------------------------------------
// Raising this app one rung

export type RaiseVia = "console" | "cli";

let raising = false;

export type RaiseOutcome =
  | { ok: true; from: Rung; expected: Rung | null; answer: unknown }
  | { ok: false; from: Rung; status: number; code: string; detail: string | null };

/**
 * Asks GLockdown to raise this app one rung (`escalate`), then asks the edge
 * again so the stage in force follows at once. GLockdown decides; an app at
 * the ceiling is refused there, not guessed at here. Every attempt that got
 * as far as asking is audited, answered or not, with the reason, which
 * GLockdown receives too.
 */
export async function raiseOneRung(args: {
  reason: string;
  actorId: string | null;
  via: RaiseVia;
}): Promise<RaiseOutcome> {
  const reason = args.reason.trim().slice(0, 500);
  const before = glockdown().reading();
  const from = currentRung(before);
  const expected = nextRung(before);
  if (!reason) {
    return { ok: false, from, status: 0, code: "no_reason", detail: "a raise needs a reason" };
  }
  // One raise at a time per process: a raise is one rung from where the stage
  // stands, so a second one overlapping the first would raise two.
  if (raising) {
    return { ok: false, from, status: 0, code: "in_progress", detail: "a raise is already on its way" };
  }
  raising = true;
  let r: EscalateResult;
  try {
    const { connection, problem } = edge();
    r = connection ? await escalate({ ...connection, reason }) : notConfigured(problem);
    if (r.ok) await glockdown().askEdge();
  } finally {
    raising = false;
  }

  const outcome: RaiseOutcome = r.ok
    ? { ok: true, from, expected, answer: r.body }
    : { ok: false, from, status: r.status, code: r.code, detail: r.detail ?? null };
  if (outcome.ok) {
    logger.warn({ from, expected, via: args.via }, "lockdown: raised one rung");
  } else {
    logger.error(
      { from, via: args.via, code: outcome.code, status: outcome.status, detail: outcome.detail },
      "lockdown: raising one rung failed",
    );
  }
  await recordAudit({
    projectId: null,
    actorId: args.actorId,
    kind: outcome.ok ? "lockdown.escalated" : "lockdown.escalate_failed",
    payload: outcome.ok
      ? { from, expected, reason, via: args.via, answer: bounded(outcome.answer) }
      : {
          from,
          reason,
          via: args.via,
          status: outcome.status,
          code: outcome.code,
          detail: outcome.detail,
        },
  }).catch((e) => logger.warn({ err: e }, "lockdown: auditing a raise failed"));
  return outcome;
}

// ---------------------------------------------------------------------------
// Honeytokens

let honey: Honeytokens | null = null;

function decoys(): Honeytokens {
  if (honey) return honey;
  honey = new Honeytokens({
    logins: env.glockdownDecoyLogins,
    keySha256: env.glockdownDecoyKeys,
    trip: (s) => tripped(s),
  });
  return honey;
}

/**
 * A decoy was used. GLockdown is told first, because that is what raises AAL
 * phase 1; then the log and the audit, which carry what tripped and where,
 * never the credential presented. The SDK calls this at most once a minute per
 * signal, so a burst costs one signal and one row. Never throws.
 */
async function tripped(s: { signal: HoneytokenSignal; detail: string }): Promise<void> {
  // Loud on purpose: nobody uses a decoy, so this line is never noise.
  logger.error({ "glockdown.signal": s.signal, detail: s.detail }, "lockdown: a decoy was used");
  const { connection, problem } = edge();
  const told: EscalateResult = connection
    ? await signal({ ...connection, ...s }).catch((e: unknown) => ({
        ok: false as const,
        status: 0,
        code: "unavailable",
        detail: e instanceof Error ? e.message : String(e),
      }))
    : notConfigured(problem);
  if (!told.ok) {
    logger.error(
      { "glockdown.signal": s.signal, code: told.code, detail: told.detail },
      "lockdown: GLockdown could not be told a decoy was used",
    );
  }
  await recordAudit({
    projectId: null,
    actorId: null,
    kind: "lockdown.decoy_tripped",
    payload: {
      signal: s.signal,
      detail: s.detail,
      told: told.ok,
      ...(told.ok ? {} : { code: told.code }),
    },
  }).catch((e) => logger.warn({ err: e }, "lockdown: auditing a decoy trip failed"));
}

/**
 * Whether a sign-in name is the decoy admin's; when it is, GLockdown is told.
 * Call it before the identity is resolved or linked, and refuse it as an
 * unknown account would be refused.
 */
export function isDecoyLogin(login: string | null | undefined, detail: string): boolean {
  if (!login || env.glockdownDecoyLogins.length === 0) return false;
  return decoys().isDecoyLogin(login, detail);
}

/** Headers an API key is commonly sent in, beside `Authorization`. */
const KEY_HEADERS = ["x-api-key", "api-key", "x-auth-token", "x-access-token", "private-token"];
/** Query parameters an API key is commonly sent in. */
const KEY_PARAMS = ["api_key", "apikey", "key", "token", "access_token"];
const MAX_KEY_LENGTH = 4096;
const MAX_CANDIDATES = 16;

/**
 * Every value in a request that could be an API key: the `Authorization`
 * credential under any scheme (and both halves of a Basic pair), the usual key
 * headers, and the usual query parameters. Bounded in count and length, so a
 * hostile request cannot make the hashing expensive.
 */
export function presentedKeys(req: Request): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t && t.length <= MAX_KEY_LENGTH && out.size < MAX_CANDIDATES) out.add(t);
  };
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const sp = authorization.indexOf(" ");
    const credential = sp === -1 ? authorization : authorization.slice(sp + 1);
    add(credential);
    if (sp !== -1 && authorization.slice(0, sp).toLowerCase() === "basic") {
      const pair = Buffer.from(credential.trim(), "base64").toString("utf8");
      const colon = pair.indexOf(":");
      add(pair);
      if (colon !== -1) {
        add(pair.slice(0, colon));
        add(pair.slice(colon + 1));
      }
    }
  }
  for (const h of KEY_HEADERS) add(req.headers.get(h));
  let params: URLSearchParams | null = null;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    params = null;
  }
  if (params) for (const p of KEY_PARAMS) for (const v of params.getAll(p)) add(v);
  return [...out];
}

/**
 * Whether a request presents a decoy API key anywhere; when it does, GLockdown
 * is told. Call it at the top of an API route and refuse the request at the
 * point an unknown key would be refused, with the same answer, so whoever
 * tried learns nothing. The detail names the method and path only: the query
 * may hold the key itself.
 */
export function presentsDecoyKey(req: Request): boolean {
  if (env.glockdownDecoyKeys.length === 0) return false;
  try {
    const where = `${req.method} ${new URL(req.url).pathname}`;
    let hit = false;
    for (const key of presentedKeys(req)) hit = decoys().isDecoyKey(key, where) || hit;
    return hit;
  } catch (e) {
    logger.warn({ err: e }, "lockdown: checking a request for decoy keys failed");
    return false;
  }
}

/** What this app holds of its decoys, as GLockdown sees it: hashes only. */
export function decoyFingerprints(): { keys: string[]; logins: string[] } {
  return decoys().fingerprints();
}

export type ReportTrigger = "start" | "daily" | "console" | "cli";

/**
 * Tells GLockdown which decoys this app holds (`reportDecoys`, L120), as
 * hashes only. Reported even when there are none: GLockdown's inventory may
 * still list decoys this app no longer checks, and that is the case the report
 * exists for. Audited, with GLockdown's answer, so the console can show when
 * it last went through. Never throws.
 */
export async function reportDecoyInventory(
  trigger: ReportTrigger,
  actorId: string | null = null,
): Promise<EscalateResult> {
  const { connection, problem } = edge();
  if (!connection) return notConfigured(problem);
  const fp = decoys().fingerprints();
  const r = await reportDecoys({ ...connection, keys: fp.keys, logins: fp.logins });
  if (!r.ok) {
    logger.warn(
      { trigger, code: r.code, status: r.status, detail: r.detail },
      "lockdown: reporting the decoys to GLockdown failed",
    );
  }
  await recordAudit({
    projectId: null,
    actorId,
    kind: r.ok ? "lockdown.decoys_reported" : "lockdown.decoys_report_failed",
    payload: {
      trigger,
      logins: fp.logins.length,
      keys: fp.keys.length,
      ...(r.ok
        ? { answer: bounded(r.body) }
        : { status: r.status, code: r.code, detail: r.detail ?? null }),
    },
  }).catch((e) => logger.warn({ err: e }, "lockdown: auditing a decoy report failed"));
  return r;
}

/** An answer from GLockdown as stored in an audit row: as is while small, cut otherwise. */
function bounded(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length <= 2000 ? v ?? null : { truncated: s.slice(0, 2000) };
}

/** For tests: forget the source, the identity and the decoys, so the next call reads the environment again. */
export function resetLockdownForTests(): void {
  source = null;
  edgeState = null;
  honey = null;
}
