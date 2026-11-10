import {
  ActivityFailure,
  ApplicationFailure,
  patched,
  sleep,
} from "@temporalio/workflow";
import { FAILURE } from "../../lib/temporal/contracts";

/** How long to wait before converging again while GMint is not answering:
 * short at first, because most outages are a restart, then every fifteen
 * minutes for as long as it takes. A sealed vault waits for a person, and the
 * outage of 2026-11-09 lasted 23 hours. */
const GMINT_WAITS = ["1 minute", "2 minutes", "5 minutes", "15 minutes"] as const;

function gmintUnavailable(e: unknown): boolean {
  return (
    e instanceof ActivityFailure &&
    e.cause instanceof ApplicationFailure &&
    e.cause.type === FAILURE.gmintUnavailable
  );
}

/**
 * Converge, and while GMint is not answering wait and converge again. The
 * activity refuses to report a converge done whose GitHub writes failed for
 * that reason (`untilGmintAnswered`), so the work is repeated until its writes
 * have really happened. The patch check sits in the failure path only, which a
 * history from before it never reached with this failure type.
 *
 * `giveUpAfterMs` bounds work that goes stale: past it the failure is thrown.
 */
export async function convergeWhenGmintAnswers<T>(
  converge: () => Promise<T>,
  patch: string,
  giveUpAfterMs?: number,
): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await converge();
    } catch (e) {
      if (!gmintUnavailable(e) || !patched(patch)) throw e;
      if (giveUpAfterMs !== undefined && Date.now() - started >= giveUpAfterMs) throw e;
      await sleep(GMINT_WAITS[Math.min(attempt, GMINT_WAITS.length - 1)]);
    }
  }
}
