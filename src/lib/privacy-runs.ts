import "server-only";
import { z } from "zod";
import { PRIVACY_CATALOGUE, runPrivacyPlan } from "@/lib/account-erasure";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { TERMS_SURFACE } from "@/lib/terms";
import { getSecret } from "@/lib/vault/resolver";

/**
 * Privacy requests from GPlatform Terms (see `account-erasure.ts`).
 *
 * Terms never calls in: the product asks. Every minute, beside the Terms
 * outbox flush, this publishes what Contribution Checker holds about people
 * (at most hourly, and on the first pass of each process), takes the runs
 * Terms has queued for its surface, carries each out or counts it (a dry run),
 * and posts the report back. A run that fails is reported as failed with its
 * reason; one that crashes before reporting is offered again by Terms after
 * its lease.
 */

const HOUR = 60 * 60 * 1000;
let publishedAt = 0;

const action = z.enum(["keep", "pseudonymise", "delete"]);
const runs = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      subject: z.object({
        email: z.string().nullable(),
        identifiers: z.record(z.string(), z.string()),
        accountIds: z.array(z.string()),
      }),
      plan: z.record(z.string(), action),
      execute: z.boolean(),
    }),
  ),
});

export async function processPrivacyRuns(
  now: number = Date.now(),
): Promise<{ taken: number; done: number; failed: number } | null> {
  if (!env.gptermsConfigured || env.GPTERMS_URL === undefined) return null;
  const apiKey = env.GPTERMS_API_KEY ?? (await getSecret("GPTERMS_API_KEY"));
  if (!apiKey) return null;
  const base = `${env.GPTERMS_URL.replace(/\/+$/, "")}/api/v1`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Terms ${method} ${path} answered ${response.status}`);
    return response.json();
  };

  if (now - publishedAt > HOUR) {
    await call("PUT", `/erasure-catalogues/${TERMS_SURFACE}`, { categories: PRIVACY_CATALOGUE });
    publishedAt = now;
  }
  const taken = runs.parse(await call("POST", `/privacy-runs/${TERMS_SURFACE}/take`)).runs;
  let done = 0;
  let failed = 0;
  for (const run of taken) {
    const path = `/privacy-runs/${TERMS_SURFACE}/${encodeURIComponent(run.id)}/report`;
    try {
      const report = await runPrivacyPlan(run.subject, run.plan, {
        execute: run.execute,
        requestRef: run.reference,
      });
      await call("POST", path, { ok: true, report });
      done += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, requestRef: run.reference, execute: run.execute }, "privacy run failed");
      await call("POST", path, { ok: false, error: message.slice(0, 2000) }).catch((reportError: unknown) =>
        logger.warn({ err: reportError, requestRef: run.reference }, "privacy run: the failure could not be reported"),
      );
    }
  }
  return { taken: taken.length, done, failed };
}
