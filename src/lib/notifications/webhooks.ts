import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { startOutboundWebhook } from "@/lib/temporal/start";

export type OutboundEvent =
  | "application.submitted"
  | "application.approved"
  | "application.denied"
  | "application.revoked"
  | "application.appeal_submitted"
  | "application.appeal_resolved"
  | "pr.blocked"
  | "cla.ccla_signed"
  | "cla.roster_changed"
  | "cla.roster_disputed";

export type WebhookKind = "generic" | "discord";

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
  "application.appeal_submitted": 0x3b82f6, // blue
  "application.appeal_resolved": 0x22c55e, // green
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
  "application.appeal_submitted": "Appeal submitted",
  "application.appeal_resolved": "Appeal resolved",
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

/**
 * Fan an outbound event out to a project's webhook endpoints. Each endpoint gets
 * its own durable `outboundWebhookDelivery` workflow that owns retry/backoff
 * (replacing the old WebhookDelivery table + in-process setInterval). The
 * delivery key is deterministic over (endpoint, event, payload) so a redelivery
 * from a retried caller dedupes onto the same workflow instead of double-firing.
 */
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
    const deliveryKey = createHash("sha256")
      .update(`${ep.id}\n${args.event}\n${body}`)
      .digest("hex")
      .slice(0, 32);

    await startOutboundWebhook(
      {
        projectId: args.projectId,
        endpointId: ep.id,
        kind,
        event: args.event,
        body,
        url: ep.url,
      },
      deliveryKey
    );
  }
}
