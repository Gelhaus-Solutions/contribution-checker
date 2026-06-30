import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";
import { withSentryScope } from "@/lib/observability/with-sentry-scope";
import {
  dispatchInstallationEvent,
  dispatchMergeGroupEvent,
  dispatchPullRequestEvent,
  dispatchPushEvent,
} from "@/lib/temporal/start";
import {
  BodyTooLargeError,
  readLimitedBody,
} from "@/lib/http/read-limited-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** Fast-path dedup of GitHub redeliveries. Workflow ids are already
 * deterministic (so a double-dispatch is harmless), but this avoids even
 * touching Temporal for an obvious duplicate. The row is written only AFTER a
 * successful dispatch, so a dispatch failure (→ 500) lets GitHub retry without
 * the delivery being marked done. Stale rows are pruned by the
 * pruneProcessedDeliveries Schedule. */
async function alreadyProcessed(deliveryId: string): Promise<boolean> {
  if (!deliveryId) return false;
  const existing = await prisma.processedWebhookDelivery.findUnique({
    where: { id: deliveryId },
    select: { id: true },
  });
  return !!existing;
}

async function markProcessed(deliveryId: string, eventName: string): Promise<void> {
  if (!deliveryId) return;
  await prisma.processedWebhookDelivery
    .create({ data: { id: deliveryId, eventName } })
    .catch(() => undefined); // P2002 on concurrent duplicate is fine
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
    Sentry.captureException(e, { tags: { "github.event": eventName } });
    logger.error({ err: e, deliveryId, eventName }, "webhook secret resolve failed");
    return NextResponse.json({ error: "Secret resolve failed" }, { status: 500 });
  }
  if (!signatureOk) {
    logger.warn({ deliveryId, eventName }, "webhook signature invalid");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (await alreadyProcessed(deliveryId)) {
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
    after?: string;
    ref?: string;
    repository?: { full_name?: string; id?: number };
    installation?: { id?: number };
    pull_request?: { number?: number; user?: { login?: string } };
    merge_group?: { head_sha?: string };
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
      // Dispatch the event into Temporal (signalWithStart / start). The webhook
      // returns immediately; the durable workflow runs the side effects with
      // retries. A dispatch failure returns 500 so GitHub retries — safe because
      // every workflow id is deterministic, so a retried dispatch is idempotent.
      const t0 = Date.now();
      const envelope = { eventName, deliveryId, payload };
      try {
        switch (eventName) {
          case "pull_request": {
            const repoId = String(p.repository?.id ?? "");
            const prNumber = p.pull_request?.number;
            if (repoId && prNumber) {
              await dispatchPullRequestEvent(repoId, prNumber, envelope);
            }
            break;
          }
          case "merge_group": {
            const repoId = String(p.repository?.id ?? "");
            const headSha = p.merge_group?.head_sha ?? deliveryId;
            await dispatchMergeGroupEvent(repoId, headSha, payload);
            break;
          }
          case "installation":
            await dispatchInstallationEvent(
              p.installation?.id ?? 0,
              deliveryId,
              "installation",
              payload
            );
            break;
          case "installation_repositories":
            await dispatchInstallationEvent(
              p.installation?.id ?? 0,
              deliveryId,
              "installation_repositories",
              payload
            );
            break;
          case "push": {
            const repoId = String(p.repository?.id ?? "");
            await dispatchPushEvent(
              repoId,
              p.ref ?? "",
              p.after ?? deliveryId,
              payload
            );
            break;
          }
          case "ping":
            return NextResponse.json({ pong: true });
          default:
            logger.debug({ eventName, deliveryId }, "unhandled GH event");
        }
      } catch (e) {
        Sentry.captureException(e, {
          tags: { "github.event": eventName, "github.delivery_id": deliveryId },
        });
        logger.error({ err: e, eventName, deliveryId }, "webhook dispatch failed");
        Sentry.metrics.count("github.webhook.event", 1, {
          attributes: {
            "github.event": eventName,
            "github.action": p.action ?? "",
            outcome: "dispatch_error",
          },
        });
        return NextResponse.json({ error: "Dispatch error" }, { status: 500 });
      }

      await markProcessed(deliveryId, eventName);

      Sentry.metrics.count("github.webhook.event", 1, {
        attributes: {
          "github.event": eventName,
          "github.action": p.action ?? "",
          outcome: "dispatched",
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
