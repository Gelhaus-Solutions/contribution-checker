import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export type OutboundEvent =
  | "application.submitted"
  | "application.approved"
  | "application.denied"
  | "application.revoked"
  | "pr.blocked";

const RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 30 * 60_000];

function signPayload(secret: string, body: string): string {
  return (
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
  );
}

export async function enqueueProjectWebhook(args: {
  projectId: string;
  event: OutboundEvent;
  payload: Record<string, unknown>;
  triggeredById?: string | null;
}): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { webhookUrl: true, webhookSecret: true },
  });
  if (!project?.webhookUrl) return;

  const body = JSON.stringify({
    event: args.event,
    project: { id: args.projectId },
    data: args.payload,
    deliveredAt: new Date().toISOString(),
  });

  const delivery = await prisma.webhookDelivery.create({
    data: {
      projectId: args.projectId,
      event: args.event,
      payload: body,
      url: project.webhookUrl,
      status: "PENDING",
      triggeredById: args.triggeredById ?? null,
      nextAttemptAt: new Date(),
    },
  });

  ensureRetryWorker();
  // Try once inline. The retry worker handles failures.
  void deliverWebhook(delivery.id).catch(() => undefined);
}

export async function deliverWebhook(id: string): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id } });
  if (!delivery) return;
  if (delivery.status === "DELIVERED") return;

  const project = await prisma.project.findUnique({
    where: { id: delivery.projectId },
    select: { webhookSecret: true },
  });
  const signature = project?.webhookSecret
    ? signPayload(project.webhookSecret, delivery.payload)
    : null;

  await prisma.webhookDelivery.update({
    where: { id },
    data: { status: "PENDING", lastAttemptAt: new Date(), attempts: delivery.attempts + 1 },
  });

  let resp: Response | null = null;
  try {
    resp = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "contribution-checker",
        "X-ContribCheck-Event": delivery.event,
        ...(signature ? { "X-ContribCheck-Signature": signature } : {}),
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    logger.warn({ err: e, id }, "webhook delivery threw");
  }

  const ok = resp?.ok === true;
  const responseBody = resp ? (await resp.text().catch(() => null))?.slice(0, 2000) ?? null : null;
  const attempts = delivery.attempts + 1;

  if (ok) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: "DELIVERED",
        responseCode: resp?.status ?? null,
        responseBody,
        nextAttemptAt: null,
      },
    });
    return;
  }

  const retryIdx = attempts - 1;
  if (retryIdx < RETRY_BACKOFFS_MS.length) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: "PENDING",
        responseCode: resp?.status ?? null,
        responseBody,
        nextAttemptAt: new Date(Date.now() + RETRY_BACKOFFS_MS[retryIdx]),
      },
    });
  } else {
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: "FAILED",
        responseCode: resp?.status ?? null,
        responseBody,
        nextAttemptAt: null,
      },
    });
  }
}

let retryWorkerStarted = false;

export function ensureRetryWorker(): void {
  if (retryWorkerStarted) return;
  retryWorkerStarted = true;
  // Single in-process tick every 60s. SQLite + single-process model is fine for this.
  setInterval(() => {
    void runOneRetryTick().catch((e) =>
      logger.warn({ err: e }, "webhook retry tick threw")
    );
  }, 60_000).unref?.();
}

async function runOneRetryTick(): Promise<void> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: new Date() },
    },
    take: 25,
    orderBy: { nextAttemptAt: "asc" },
    select: { id: true },
  });
  for (const d of due) {
    await deliverWebhook(d.id);
  }
}
