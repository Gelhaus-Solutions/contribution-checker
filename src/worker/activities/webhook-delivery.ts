import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/http/safe-url";
import type {
  OutboundWebhookInput,
  OutboundAttemptResult,
} from "@/lib/temporal/contracts";

const MAX_RESPONSE_BODY_BYTES = 256;

function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * One outbound webhook POST attempt. The retry policy and backoff are owned by
 * the `outboundWebhookDelivery` workflow (durable, replacing the old in-process
 * setInterval); this activity is a single, side-effect-bounded attempt.
 *
 * Returns a structured result rather than throwing on HTTP failure so the
 * workflow can decide retry-vs-fail deterministically. The endpoint secret is
 * read here (not passed through workflow history) so signing material never
 * lands in Temporal.
 */
export async function deliverOutboundAttempt(
  input: OutboundWebhookInput
): Promise<OutboundAttemptResult> {
  // SSRF preflight. A blocked URL is a permanent failure, not a transient one.
  try {
    await assertSafeOutboundUrl(input.url);
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) {
      return {
        ok: false,
        status: null,
        responseBody: `[blocked] ${e.message}`.slice(0, MAX_RESPONSE_BODY_BYTES),
        blocked: true,
      };
    }
    throw e;
  }

  let secret: string | null = null;
  if (input.kind === "generic") {
    const ep = await prisma.projectWebhook.findUnique({
      where: { id: input.endpointId },
      select: { secret: true },
    });
    secret = ep?.secret ?? null;
  }
  const signature = secret ? signPayload(secret, input.body) : null;

  let resp: Response | null = null;
  try {
    resp = await fetch(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "contribution-checker",
        ...(input.kind === "generic"
          ? { "X-ContribCheck-Event": input.event }
          : {}),
        ...(signature ? { "X-ContribCheck-Signature": signature } : {}),
      },
      body: input.body,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch (e) {
    logger.warn({ err: e, url: input.url }, "outbound webhook attempt threw");
    return { ok: false, status: null, responseBody: null, blocked: false };
  }

  const responseBody =
    (await resp.text().catch(() => null))?.slice(0, MAX_RESPONSE_BODY_BYTES) ??
    null;
  return {
    ok: resp.ok,
    status: resp.status,
    responseBody,
    blocked: false,
  };
}
