import { flushTermsOutbox as flush } from "@/lib/gpterms";

/**
 * Sends GPlatform Terms whatever its outbox holds that is due: the account
 * pushes and acceptances written while the service was away or slow
 * (GPLATTERMS-43). Without Terms configured it does nothing.
 */
export async function flushTermsOutbox(): Promise<{
  delivered: number;
  retrying: number;
  parked: number;
} | null> {
  const report = await flush();
  if (report === null) return null;
  return { delivered: report.delivered, retrying: report.retrying, parked: report.parked };
}
