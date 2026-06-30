import { sleep, ApplicationFailure } from "@temporalio/workflow";
import { outboundActs } from "./proxies";
import {
  OUTBOUND_RETRY_BACKOFFS_MS,
} from "../../lib/temporal/contracts";
import type { OutboundWebhookInput } from "../../lib/temporal/contracts";

/**
 * Durable replacement for the in-process setInterval webhook retry worker. One
 * execution per delivery. Owns the exact legacy backoff schedule (1m, 5m, 30m
 * after the first attempt) via durable timers, so a retry survives restarts and
 * never races across instances.
 *
 * A blocked (SSRF-unsafe) URL is a permanent failure: no retry. Exhausting all
 * attempts throws an ApplicationFailure so the run is visibly failed in Temporal
 * (and surfaced to Sentry/audit/dashboard via the worker's failure interceptor).
 */
export async function outboundWebhookDelivery(
  input: OutboundWebhookInput
): Promise<{ status: number | null }> {
  const maxAttempts = OUTBOUND_RETRY_BACKOFFS_MS.length + 1; // 4 total
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await outboundActs.deliverOutboundAttempt(input);
    if (res.ok) return { status: res.status };
    if (res.blocked) {
      throw ApplicationFailure.nonRetryable(
        `outbound webhook blocked: ${res.responseBody ?? "unsafe URL"}`,
        "WebhookBlocked"
      );
    }
    if (attempt < maxAttempts) {
      await sleep(OUTBOUND_RETRY_BACKOFFS_MS[attempt - 1]);
    }
  }
  throw ApplicationFailure.nonRetryable(
    `outbound webhook failed after ${maxAttempts} attempts`,
    "WebhookExhausted"
  );
}
