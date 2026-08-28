import { NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { signalQaBoardSync } from "@/lib/temporal/start";
import { boardCallbackUrl } from "@/lib/qa/board/sync";
import {
  BodyTooLargeError,
  readLimitedBody,
} from "@/lib/http/read-limited-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 262_144;

/**
 * Provider callbacks for the external QA board mirror.
 *
 * These only ever say "something over here changed"; they carry no state we
 * act on. The sync entity re-reads the provider either way, so this route's
 * whole job is to make the next pass happen in seconds instead of at the next
 * poll. That is why an unrecognised or unverifiable payload returns 200 and
 * does nothing: the poll will pick the change up regardless, and a 500 would
 * only earn us a retry storm for a message we were never going to read.
 *
 * A bad signature is the one exception. That is not a message we failed to
 * understand, it is one that did not come from the provider.
 */

/**
 * Trello signs with HMAC-SHA1 over the request body concatenated with the exact
 * callback URL it was registered against.
 */
function verifyTrello(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha1", secret)
    .update(rawBody + boardCallbackUrl("trello"))
    .digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Notion signs with HMAC-SHA256 over the raw body, prefixed `sha256=`. */
function verifyNotion(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Trello probes the callback URL with a HEAD request when the webhook is
 * registered and refuses to create it unless that returns 200.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export async function GET() {
  // Trello also accepts a GET probe on some paths; same contract.
  return new NextResponse(null, { status: 200 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  if (provider !== "notion" && provider !== "trello") {
    return NextResponse.json({ ok: true, ignored: "unknown provider" });
  }

  let rawBody: string;
  try {
    rawBody = await readLimitedBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: true, ignored: "unreadable body" });
  }

  // Notion's one-time endpoint handshake: it posts a verification token that
  // has to be echoed back to activate the subscription.
  if (provider === "notion") {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const token =
        parsed && typeof parsed === "object"
          ? (parsed as { verification_token?: unknown }).verification_token
          : undefined;
      if (typeof token === "string") {
        logger.info({ provider }, "notion webhook verification token received");
        return NextResponse.json({ verification_token: token });
      }
    } catch {
      // Not JSON; fall through to the signature check, which will reject it.
    }
  }

  // The links that could have sent this. A callback carries no repo id, so the
  // signature is checked against each candidate secret until one matches. This
  // is bounded by the number of links for that provider across the instance,
  // and it is why the route does nothing but signal: it never has to decide
  // *which* board changed, only that this one is genuine.
  const links = await prisma.qaBoardLink.findMany({
    where: { provider, enabled: true },
    select: { id: true, repoId: true, token: true, apiKey: true },
  });
  if (links.length === 0) {
    return NextResponse.json({ ok: true, ignored: "no links" });
  }

  const trelloSig = req.headers.get("x-trello-webhook");
  const notionSig = req.headers.get("x-notion-signature");

  const matched = links.filter((link) =>
    provider === "trello"
      ? // Trello signs with the application secret, which for this integration
        // is the API key stored alongside the token.
        verifyTrello(rawBody, trelloSig, link.apiKey ?? "")
      : verifyNotion(rawBody, notionSig, link.token),
  );

  if (matched.length === 0) {
    logger.warn({ provider }, "qa board callback signature did not verify");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Cheap replay guard, reusing the same table the GitHub webhook prunes. The
  // id is derived from the body because neither provider sends a delivery id.
  const deliveryId = `qa-${provider}-${createHash("sha256")
    .update(rawBody)
    .digest("hex")
    .slice(0, 32)}`;
  const seen = await prisma.processedWebhookDelivery.findUnique({
    where: { id: deliveryId },
    select: { id: true },
  });
  if (seen) return NextResponse.json({ ok: true, duplicate: true });

  for (const repoId of new Set(matched.map((l) => l.repoId))) {
    await signalQaBoardSync({ repoId, reason: `${provider}_callback` });
  }

  await prisma.processedWebhookDelivery
    .create({ data: { id: deliveryId, eventName: `qa.${provider}` } })
    .catch(() => undefined);

  return NextResponse.json({ ok: true });
}
