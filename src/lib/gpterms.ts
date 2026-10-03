import "server-only";
import {
  createTermsClient,
  postgresOutboxStore,
  type FlushReport,
  type TermsClient,
} from "@ghub/terms-client";
import { offline, type Terms } from "@ghub/terms-rules";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  decidingRecord,
  documentsToAccept,
  standingAt,
  TERMS_SURFACE,
  weighed,
  type TermsAccount,
  type TermsStanding,
} from "@/lib/terms";
import { getSecret } from "@/lib/vault/resolver";

/**
 * Contribution Checker's side of GPlatform Terms (GPLATTERMS-43), through
 * `@ghub/terms-client`.
 *
 * The hosted instance asks the service where an account stands, records every
 * acceptance in its ledger and tells it about every account. Each push and
 * each acceptance is written to the `terms_outbox` table first, so nothing is
 * lost while the service is away; the worker flushes it every minute.
 *
 * **Nobody is locked out because Terms is down or behind.** Without the
 * service (not configured, or not answering), the standing is decided here
 * from the newest verified snapshot the client holds, or the one the installed
 * `@ghub/terms-rules` carries, and the account's own `TermsAcceptance` rows.
 */

let client: Promise<TermsClient | null> | undefined;

async function connect(): Promise<TermsClient | null> {
  if (!env.gptermsConfigured || env.GPTERMS_URL === undefined) return null;
  const apiKey = env.GPTERMS_API_KEY ?? (await getSecret("GPTERMS_API_KEY"));
  if (!apiKey) {
    logger.warn("gpterms: GPTERMS_URL is set but no GPTERMS_API_KEY could be read; deciding locally");
    return null;
  }
  const made = createTermsClient({
    baseUrl: env.GPTERMS_URL,
    apiKey,
    outbox: postgresOutboxStore((text, values) => prisma.$queryRawUnsafe(text, ...values)),
    onError: (error, context) => {
      logger.warn(
        { "terms.error": error instanceof Error ? error.message : String(error) },
        `gpterms: ${context}`,
      );
    },
  });
  // Never throws: a process that starts while Terms is unreachable still
  // starts, deciding from the snapshot its release carries.
  const ready = await made.ready();
  logger.info(
    { "terms.snapshot": ready.snapshot ?? -1, "terms.snapshot_source": ready.source ?? "none" },
    "gpterms ready",
  );
  return made;
}

/** The client, made once per process on first use; null where Terms is not used. */
function termsClient(): Promise<TermsClient | null> {
  client ??= connect().catch((error: unknown) => {
    logger.warn({ err: error }, "gpterms: the client could not be made; deciding locally");
    return null;
  });
  return client;
}

/** The rules bound to the newest verified snapshot held, else the release's own. */
export async function termsRules(): Promise<Terms> {
  const made = await termsClient();
  if (made === null) return offline();
  try {
    return made.terms();
  } catch {
    return offline();
  }
}

/** Every acceptance an account recorded here, oldest first. */
async function acceptedBy(userId: string): Promise<string[]> {
  const rows = await prisma.termsAcceptance.findMany({
    where: { userId },
    orderBy: { acceptedAt: "asc" },
    select: { version: true },
  });
  return rows.map((row) => row.version);
}

/**
 * Where an account stands at `now`: asked of the service where there is one,
 * and weighed against what this product's own record says (`weighed`).
 */
export async function standingOf(
  user: { id: string; createdAt: Date },
  now: Date = new Date(),
): Promise<TermsStanding> {
  const [rules, made, accepted] = await Promise.all([
    termsRules(),
    termsClient(),
    acceptedBy(user.id),
  ]);
  const account: TermsAccount = { createdAt: user.createdAt, accepted };
  const local = standingAt(rules, account, now);
  if (made === null || local.kind === "first") return local;
  const answer = await made.stateOf(
    TERMS_SURFACE,
    user.id,
    { recorded: decidingRecord(rules, account), paid: false },
    now,
  );
  if (answer.source !== "gpterms" || answer.state === null) return local;
  return weighed(local, answer.state, answer.toRecord, accepted.length === 0);
}

/** The documents accepting now covers, from the same rules the standing came from. */
export async function termsToAccept(now: Date = new Date()) {
  return documentsToAccept(await termsRules(), now);
}

/**
 * Tells Terms about an account: when it is made, and again before an
 * acceptance so the ledger always holds the account it records against.
 * Returns once the push is in the outbox; never throws for the service.
 */
export async function pushAccount(user: { id: string; email: string | null }): Promise<void> {
  const made = await termsClient();
  if (made === null || user.email === null) return;
  try {
    await made.upsertSubject(TERMS_SURFACE, user.id, { email: user.email, locale: null, paid: false });
  } catch (error) {
    logger.warn({ err: error, "auth.user_id": user.id }, "gpterms: pushing the account failed");
  }
}

/** Tells Terms an account is gone, before its address is erased here, so it is never sent a notice again. */
export async function closeAccount(
  user: { id: string; email: string | null },
  closedAt: Date = new Date(),
): Promise<void> {
  const made = await termsClient();
  if (made === null || user.email === null) return;
  try {
    await made.closeSubject(
      TERMS_SURFACE,
      user.id,
      { email: user.email, locale: null, paid: false },
      closedAt,
    );
  } catch (error) {
    logger.warn({ err: error, "auth.user_id": user.id }, "gpterms: closing the account failed");
  }
}

/**
 * Records an acceptance in Terms' ledger, after the `TermsAcceptance` row and
 * its audit entry are written here. The reference is the account and the
 * version, so a second send is the same ledger row.
 */
export async function recordAcceptance(input: {
  userId: string;
  email: string | null;
  recorded: string;
  acceptedAt: Date;
  first: boolean;
}): Promise<void> {
  const made = await termsClient();
  if (made === null) return;
  await pushAccount({ id: input.userId, email: input.email });
  try {
    const outcome = await made.recordConsent({
      surface: TERMS_SURFACE,
      accountId: input.userId,
      recorded: input.recorded,
      acceptedAt: input.acceptedAt,
      source: input.first ? "sign-up" : "accept-screen",
      requestRef: `${input.userId}:${input.recorded}`,
      ip: null,
      userAgent: null,
    });
    if (outcome.outcome === "parked") {
      logger.warn(
        { "terms.request_ref": outcome.requestRef, "terms.why": outcome.why ?? "refused" },
        "gpterms: an acceptance was parked",
      );
    }
  } catch (error) {
    logger.warn({ err: error, "auth.user_id": input.userId }, "gpterms: recording an acceptance failed");
  }
}

/** Sends whatever the outbox holds that is due. Run every minute by the worker. */
export async function flushTermsOutbox(): Promise<FlushReport | null> {
  const made = await termsClient();
  if (made === null) return null;
  return made.flushOutbox();
}
