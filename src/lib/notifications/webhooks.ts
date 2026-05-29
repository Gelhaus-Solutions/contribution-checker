import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/http/safe-url";

const MAX_RESPONSE_BODY_BYTES = 256;

export type OutboundEvent =
  | "application.submitted"
  | "application.approved"
  | "application.denied"
  | "application.revoked"
  | "pr.blocked"
  | "cla.ccla_signed"
  | "cla.roster_changed"
  | "cla.roster_disputed";

export type WebhookKind = "generic" | "discord";

const RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 30 * 60_000];

function signPayload(secret: string, body: string): string {
  return (
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
  );
}

function genericBody(args: {
  projectId: string;
  event: OutboundEvent;
  payload: Record<string, unknown>;
}): string {
  return JSON.stringify({
    event: args.event,
    project: { id: args.projectId },
    data: args.payload,
    deliveredAt: new Date().toISOString(),
  });
}

const DISCORD_COLOR: Record<OutboundEvent, number> = {
  "application.submitted": 0x3b82f6, // blue
  "application.approved": 0x22c55e, // green
  "application.denied": 0xef4444, // red
  "application.revoked": 0xf59e0b, // amber
  "pr.blocked": 0xef4444, // red
  "cla.ccla_signed": 0x22c55e, // green
  "cla.roster_changed": 0x3b82f6, // blue
  "cla.roster_disputed": 0xf59e0b, // amber
};

const DISCORD_TITLE: Record<OutboundEvent, string> = {
  "application.submitted": "Application submitted",
  "application.approved": "Application approved",
  "application.denied": "Application denied",
  "application.revoked": "Application revoked",
  "pr.blocked": "Pull request blocked",
  "cla.ccla_signed": "Corporate CLA signed",
  "cla.roster_changed": "CCLA roster changed",
  "cla.roster_disputed": "CCLA roster membership disputed",
};

function discordBody(args: {
  projectId: string;
  event: OutboundEvent;
  payload: Record<string, unknown>;
}): string {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  for (const [k, v] of Object.entries(args.payload)) {
    if (v == null) continue;
    let value: string;
    if (typeof v === "string") value = v;
    else if (typeof v === "number" || typeof v === "boolean") value = String(v);
    else value = "```json\n" + JSON.stringify(v).slice(0, 900) + "\n```";
    if (value.length > 1024) value = value.slice(0, 1021) + "...";
    fields.push({ name: k, value, inline: typeof v !== "object" });
  }

  return JSON.stringify({
    username: "contribution-checker",
    embeds: [
      {
        title: DISCORD_TITLE[args.event],
        description: `Project \`${args.projectId}\``,
        color: DISCORD_COLOR[args.event],
        fields: fields.slice(0, 25),
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

function formatBody(
  kind: WebhookKind,
  args: {
    projectId: string;
    event: OutboundEvent;
    payload: Record<string, unknown>;
  }
): string {
  return kind === "discord" ? discordBody(args) : genericBody(args);
}

function isDiscordKind(k: string): k is WebhookKind {
  return k === "discord" || k === "generic";
}

export async function enqueueProjectWebhook(args: {
  projectId: string;
  event: OutboundEvent;
  payload: Record<string, unknown>;
  triggeredById?: string | null;
  /** Optional: only enqueue to this specific endpoint (used by "send test"). */
  endpointId?: string | null;
}): Promise<void> {
  const endpoints = await prisma.projectWebhook.findMany({
    where: {
      projectId: args.projectId,
      enabled: true,
      ...(args.endpointId ? { id: args.endpointId } : {}),
    },
    select: { id: true, kind: true, url: true },
  });
  if (endpoints.length === 0) return;

  for (const ep of endpoints) {
    const kind: WebhookKind = isDiscordKind(ep.kind) ? ep.kind : "generic";
    const body = formatBody(kind, {
      projectId: args.projectId,
      event: args.event,
      payload: args.payload,
    });

    const delivery = await prisma.webhookDelivery.create({
      data: {
        projectId: args.projectId,
        endpointId: ep.id,
        kind,
        event: args.event,
        payload: body,
        url: ep.url,
        status: "PENDING",
        triggeredById: args.triggeredById ?? null,
        nextAttemptAt: new Date(),
      },
    });

    ensureRetryWorker();
    void deliverWebhook(delivery.id).catch(() => undefined);
  }
}

export async function deliverWebhook(id: string): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id },
    include: { endpoint: { select: { secret: true } } },
  });
  if (!delivery) return;
  if (delivery.status === "DELIVERED") return;

  const kind: WebhookKind = isDiscordKind(delivery.kind) ? delivery.kind : "generic";
  const signature =
    kind === "generic" && delivery.endpoint?.secret
      ? signPayload(delivery.endpoint.secret, delivery.payload)
      : null;

  await prisma.webhookDelivery.update({
    where: { id },
    data: { status: "PENDING", lastAttemptAt: new Date(), attempts: delivery.attempts + 1 },
  });

  let resp: Response | null = null;
  let preflightError: Error | null = null;
  try {
    await assertSafeOutboundUrl(delivery.url);
    resp = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "contribution-checker",
        ...(kind === "generic"
          ? { "X-ContribCheck-Event": delivery.event }
          : {}),
        ...(signature ? { "X-ContribCheck-Signature": signature } : {}),
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) preflightError = e;
    logger.warn({ err: e, id }, "webhook delivery threw");
  }

  const ok = resp?.ok === true;
  const responseBody = preflightError
    ? `[blocked] ${preflightError.message}`.slice(0, MAX_RESPONSE_BODY_BYTES)
    : resp
      ? (await resp.text().catch(() => null))?.slice(0, MAX_RESPONSE_BODY_BYTES) ?? null
      : null;
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

  if (preflightError) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: "FAILED",
        responseCode: null,
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
