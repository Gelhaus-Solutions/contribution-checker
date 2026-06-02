import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";
import { isValidCountryCode } from "@/lib/countries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_048_576;
const TIMESTAMP_TOLERANCE_S = 5 * 60;

/**
 * Hexclave (Stack Auth) webhook: keeps the local User row in sync with Hexclave.
 * Signed with Svix / Standard Webhooks; verified manually (no svix dep), the
 * same HMAC approach the GitHub webhook uses.
 *
 * Handled events:
 *  - user.updated: mirror email / display name / country (clientReadOnlyMetadata)
 *  - user.deleted: unlink stackUserId (we keep the local row so applications,
 *    memberships, and audit history are preserved).
 */

/** Verify the Svix signature header (`v1,<base64>` entries, space-separated). */
function verifySvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  signatureHeader: string,
  body: string,
): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "base64");
  return signatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean)
    .some((sig) => {
      try {
        const sigBuf = Buffer.from(sig, "base64");
        return (
          sigBuf.length === expectedBuf.length &&
          timingSafeEqual(sigBuf, expectedBuf)
        );
      } catch {
        return false;
      }
    });
}

const eventSchema = z.object({
  type: z.string(),
  data: z
    .object({
      id: z.string().optional(),
      primary_email: z.string().nullable().optional(),
      display_name: z.string().nullable().optional(),
      profile_image_url: z.string().nullable().optional(),
      client_read_only_metadata: z.record(z.unknown()).nullable().optional(),
    })
    .passthrough(),
});

export async function POST(req: Request) {
  const secret = await getSecret("STACK_WEBHOOK_SECRET");
  if (!secret) {
    logger.warn({}, "stack webhook: STACK_WEBHOOK_SECRET not configured");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // Accept both the Standard-Webhooks header names (webhook-*) and Svix's
  // default header names (svix-*); Hexclave uses Svix, which sends svix-*.
  const id = req.headers.get("webhook-id") ?? req.headers.get("svix-id");
  const timestamp =
    req.headers.get("webhook-timestamp") ?? req.headers.get("svix-timestamp");
  const signature =
    req.headers.get("webhook-signature") ?? req.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    logger.warn(
      {
        "has.id": !!id,
        "has.timestamp": !!timestamp,
        "has.signature": !!signature,
      },
      "stack webhook: missing signature headers (expected webhook-*/svix-*)",
    );
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Reject stale deliveries (replay protection).
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_S
  ) {
    logger.warn(
      { "stack.webhook_id": id, "webhook.timestamp": timestamp },
      "stack webhook: timestamp outside tolerance (clock skew?)",
    );
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }
  if (!verifySvixSignature(secret, id, timestamp, signature, body)) {
    logger.warn(
      { "stack.webhook_id": id },
      "stack webhook: signature verification failed (check STACK_WEBHOOK_SECRET matches the endpoint secret)",
    );
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Past verification: never throw out (Svix retries forever); log and 200.
  try {
    const parsed = eventSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      logger.warn({ "stack.webhook_id": id }, "stack webhook: unparseable payload");
      return NextResponse.json({ ok: true });
    }
    const { type, data } = parsed.data;
    const stackUserId = data.id;

    if (stackUserId && type === "user.updated") {
      const country =
        typeof data.client_read_only_metadata?.country === "string"
          ? (data.client_read_only_metadata.country as string).toUpperCase()
          : null;
      await prisma.user.updateMany({
        where: { stackUserId },
        data: {
          ...(data.display_name !== undefined ? { name: data.display_name } : {}),
          ...(country && isValidCountryCode(country) ? { country } : {}),
        },
      });
    } else if (stackUserId && type === "user.deleted") {
      // Keep the local row (FKs / audit), just unlink the identity.
      await prisma.user.updateMany({
        where: { stackUserId },
        data: { stackUserId: null },
      });
      logger.info({ "stack.user_id": stackUserId }, "stack webhook: user.deleted, unlinked local row");
    }
  } catch (e) {
    logger.error({ err: e, "stack.webhook_id": id }, "stack webhook: handler error");
    Sentry.captureException(e);
  }

  return NextResponse.json({ ok: true });
}
