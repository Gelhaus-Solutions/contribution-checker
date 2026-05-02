import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  handleInstallationEvent,
  handleInstallationReposEvent,
  handlePullRequestEvent,
} from "@/lib/github/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !env.GITHUB_APP_WEBHOOK_SECRET) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", env.GITHUB_APP_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
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

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const eventName = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  if (!verifySignature(rawBody, signature)) {
    logger.warn({ deliveryId, eventName }, "webhook signature invalid");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Dispatch by event. Each handler is wrapped so a single failing event
  // never stalls the GitHub webhook delivery (which would back off and retry).
  try {
    switch (eventName) {
      case "pull_request":
        await handlePullRequestEvent(payload as never);
        break;
      case "installation":
        await handleInstallationEvent(payload as never);
        break;
      case "installation_repositories":
        await handleInstallationReposEvent(payload as never);
        break;
      case "ping":
        return NextResponse.json({ pong: true });
      default:
        logger.debug({ eventName, deliveryId }, "unhandled GH event");
    }
  } catch (e) {
    logger.error(
      { err: e, eventName, deliveryId },
      "webhook handler threw"
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
