import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { reconcileOrgPermissions } from "@/lib/auth/sync-user";
import { getSecret } from "@/lib/vault/resolver";
import { getStackServerApp } from "@/lib/stack";
import { isInstanceAdminTeam } from "@/lib/stack-provisioning";
import { readTeamMemberships } from "@/lib/stack-teams";
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
 *  - team.* / team_membership.* / team_permission.*: reconcile the local
 *    ProjectMember cache (or, for the Instance Admin team, the super-admin
 *    cache) so changes made directly in Hexclave land locally. Event names are
 *    matched defensively (prefix "team") since the SDK types don't cover the
 *    webhook payloads.
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
      // Team events (defensive: exact payload shape isn't in the SDK types).
      team_id: z.string().optional(),
      user_id: z.string().optional(),
    })
    .passthrough(),
});

/**
 * Reconcile a project's local ProjectMember cache from the Stack Auth team
 * roster (the source of truth): upsert every linked member with their derived
 * role + effective leaf set, and delete local members no longer in the team.
 * Members with no stackUserId are left alone (SA has no opinion on them).
 */
async function reconcileProjectMembers(
  projectId: string,
  teamId: string,
): Promise<void> {
  const roster = (await readTeamMemberships(teamId)).filter(
    (r): r is { stackUserId: string; role: "OWNER" | "ADMIN" | "REVIEWER"; leaves: string[] } =>
      r.role !== null,
  );
  const stackIds = roster.map((r) => r.stackUserId);
  const rosterStackSet = new Set(stackIds);

  const users = await prisma.user.findMany({
    where: { stackUserId: { in: stackIds } },
    select: { id: true, stackUserId: true },
  });
  const localByStack = new Map(users.map((u) => [u.stackUserId as string, u.id]));

  for (const r of roster) {
    const userId = localByStack.get(r.stackUserId);
    if (!userId) continue; // SA member not linked to a local user yet
    const permissions = JSON.stringify(r.leaves);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { role: r.role, permissions },
      create: { projectId, userId, role: r.role, permissions },
    });
  }

  const localMembers = await prisma.projectMember.findMany({
    where: { projectId },
    select: { id: true, user: { select: { stackUserId: true } } },
  });
  for (const m of localMembers) {
    const sid = m.user.stackUserId;
    if (sid && !rosterStackSet.has(sid)) {
      await prisma.projectMember.delete({ where: { id: m.id } });
    }
  }
}

/** Reconcile local state for a team event, by team id and (optional) affected user. */
async function reconcileTeam(
  teamId: string,
  affectedUserId: string | null,
  type: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { teamId },
    select: { id: true },
  });

  if (project) {
    if (type === "team.deleted") {
      // The backing team is gone; unlink it but keep the local membership cache.
      await prisma.project.update({
        where: { id: project.id },
        data: { teamId: null },
      });
      return;
    }
    await reconcileProjectMembers(project.id, teamId);
    await recordAudit({
      projectId: project.id,
      actorId: null,
      kind: "team.reconciled",
      payload: { teamId, type },
    });
    return;
  }

  // Not a project team: if it's the Instance Admin team, re-mirror the affected
  // user's super-admin cache (auth() would also self-correct on their next
  // request; this just makes it immediate).
  if (!affectedUserId) return;
  const app = await getStackServerApp();
  const team = await app.getTeam(teamId);
  if (!team || !isInstanceAdminTeam(team)) return;
  const [stackUser, local] = await Promise.all([
    app.getUser(affectedUserId),
    prisma.user.findUnique({
      where: { stackUserId: affectedUserId },
      select: { id: true },
    }),
  ]);
  if (stackUser && local) await reconcileOrgPermissions(stackUser, local.id);
}

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
    } else if (type.startsWith("team")) {
      // team.created/updated/deleted -> the team is data.id;
      // team_membership.* / team_permission.* -> data.team_id.
      const teamId =
        data.team_id ?? (type.startsWith("team.") ? data.id : undefined);
      if (teamId) await reconcileTeam(teamId, data.user_id ?? null, type);
    }
  } catch (e) {
    logger.error({ err: e, "stack.webhook_id": id }, "stack webhook: handler error");
    Sentry.captureException(e);
  }

  return NextResponse.json({ ok: true });
}
