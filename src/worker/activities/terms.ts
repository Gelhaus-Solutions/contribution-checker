import { flushTermsOutbox as flush } from "@/lib/gpterms";
import { logger } from "@/lib/logger";
import { processPrivacyRuns } from "@/lib/privacy-runs";

/**
 * Sends GPlatform Terms whatever its outbox holds that is due: the account
 * pushes and acceptances written while the service was away or slow
 * (GPLATTERMS-43), then takes the privacy runs Terms has queued for this
 * product. Without Terms configured it does nothing.
 */
export async function flushTermsOutbox(): Promise<{
  delivered: number;
  retrying: number;
  parked: number;
} | null> {
  const report = await flush();
  // Privacy requests ride the same minute: Terms cannot call in, so the
  // product asks it for queued runs (src/lib/privacy-runs.ts). A failure here
  // never costs the outbox its flush.
  await processPrivacyRuns().catch((error: unknown) =>
    logger.warn({ err: error }, "privacy runs: Terms could not be asked"),
  );
  if (report === null) return null;
  return { delivered: report.delivered, retrying: report.retrying, parked: report.parked };
}
