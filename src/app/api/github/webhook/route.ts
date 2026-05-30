import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";
import { withSentryScope } from "@/lib/observability/with-sentry-scope";
import {
  handleInstallationEvent,
  handleInstallationReposEvent,
  handleMergeGroupEvent,
  handlePullRequestEvent,
  handlePushEvent,
} from "@/lib/github/webhook";
import {
  BodyTooLargeError,
  readLimitedBody,
} from "@/lib/http/read-limited-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
let lastDeliveryPruneAt = 0;

async function claimDelivery(deliveryId: string, eventName: string): Promise<boolean> {
  if (!deliveryId) return true;
  try {
    await prisma.processedWebhookDelivery.create({
      data: { id: deliveryId, eventName },
    });
    void pruneStaleDeliveries();
    return true;
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return false;
    }
    throw e;
  }
}

async function pruneStaleDeliveries(): Promise<void> {
  const now = Date.now();
  if (now - lastDeliveryPruneAt < 60 * 60 * 1000) return;
  lastDeliveryPruneAt = now;
  try {
    await prisma.processedWebhookDelivery.deleteMany({
      where: { createdAt: { lt: new Date(now - DELIVERY_RETENTION_MS) } },
    });
  } catch (e) {
    logger.warn({ err: e }, "processed-delivery prune failed");
  }
}

async function verifySignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!signature) return false;
  const secret = await getSecret("GITHUB_APP_WEBHOOK_SECRET");
  if (!secret) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!env.githubAppConfigured) {
    return NextResponse.json(
      { error: "GitHub App not configured" },
      { status: 503 }
    );
  }

  let rawBody: string;
  try {
    rawBody = await readLimitedBody(req, MAX_WEBHOOK_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    throw e;
  }
  const signature = req.headers.get("x-hub-signature-256");
  const eventName = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  let signatureOk: boolean;
  try {
    signatureOk = await verifySignature(rawBody, signature);
  } catch (e) {
    // Vault unreachable or webhook secret can't be resolved → fail closed.
    Sentry.captureException(e, { tags: { "github.event": eventName } });
    logger.error({ err: e, deliveryId, eventName }, "webhook secret resolve failed");
    return NextResponse.json({ error: "Secret resolve failed" }, { status: 500 });
  }
  if (!signatureOk) {
    logger.warn({ deliveryId, eventName }, "webhook signature invalid");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Idempotency: GitHub retries deliveries whenever it doesn't see a 2xx
  // quickly enough. Without this guard, every retry replays the full pipeline
  // (PrCheck upsert, label calls, decision comment, outbound webhook fanout).
  const claimed = await claimDelivery(deliveryId, eventName);
  if (!claimed) {
    logger.info({ deliveryId, eventName }, "duplicate webhook delivery; skipping");
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const p = payload as {
    action?: string;
    repository?: { full_name?: string; id?: number };
    installation?: { id?: number };
    pull_request?: { number?: number; user?: { login?: string } };
  };

  return withSentryScope(
    {
      "github.delivery_id": deliveryId,
      "github.event": eventName,
      "github.action": p.action,
      "github.installation_id": p.installation?.id,
      "github.repo": p.repository?.full_name,
      "github.repo_id": p.repository?.id,
      "github.pr_number": p.pull_request?.number,
      "github.pr_author": p.pull_request?.user?.login,
    },
    async () => {
      // Dispatch by event. Each handler is wrapped so a single failing event
      // never stalls the GitHub webhook delivery (which would back off and retry).
      const t0 = Date.now();
      try {
        switch (eventName) {
          case "pull_request":
            await handlePullRequestEvent(payload as never);
            break;
          case "merge_group":
            await handleMergeGroupEvent(payload as never);
            break;
          case "installation":
            await handleInstallationEvent(payload as never);
            break;
          case "installation_repositories":
            await handleInstallationReposEvent(payload as never);
            break;
          case "push":
            await handlePushEvent(payload as never);
            break;
          case "ping":
            return NextResponse.json({ pong: true });
          default:
            logger.debug({ eventName, deliveryId }, "unhandled GH event");
        }
      } catch (e) {
        Sentry.captureException(e, {
          tags: { "github.event": eventName, "github.delivery_id": deliveryId },
        });
        logger.error(
          { err: e, eventName, deliveryId },
          "webhook handler threw"
        );
        Sentry.metrics.count("github.webhook.event", 1, {
          attributes: {
            "github.event": eventName,
            "github.action": p.action ?? "",
            outcome: "error",
          },
        });
        return NextResponse.json({ error: "Handler error" }, { status: 500 });
      }

      Sentry.metrics.count("github.webhook.event", 1, {
        attributes: {
          "github.event": eventName,
          "github.action": p.action ?? "",
          outcome: "ok",
        },
      });
      Sentry.metrics.distribution("github.webhook.duration", Date.now() - t0, {
        unit: "millisecond",
        attributes: {
          "github.event": eventName,
          "github.action": p.action ?? "",
        },
      });

      return NextResponse.json({ ok: true });
    }
  );
}
