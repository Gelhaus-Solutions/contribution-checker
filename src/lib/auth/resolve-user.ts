import "server-only";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordSignInMetric } from "@/lib/auth/sync-user";

/**
 * The subset of a Hexclave server user we read on the hot path. Kept narrow so
 * this module does not couple to the full `@hexclave/next` user type.
 */
export type StackUserLike = {
  id: string;
  primaryEmail: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
};

/**
 * Resolve a Hexclave session to a local `User` row, establishing the invariant
 * "a Hexclave session implies exactly one local User row" so every downstream
 * `session.user.id` is a valid local FK target.
 *
 * Cheap hot-path resolution only (no GitHub API calls, no permission writes):
 *   1. Link by `stackUserId` (the normal case once linked / backfilled).
 *   2. Else link an existing row by matching email (lazy-link fallback).
 *   3. Else create a minimal row.
 *
 * GitHub identity (ghId/ghLogin), org permissions, and country are filled in by
 * the onboarding flow (src/lib/auth/sync-user.ts), not here.
 */
export async function resolveLocalUserFromStack(
  stackUser: StackUserLike,
): Promise<User> {
  // 1. Already linked.
  const byStackId = await prisma.user.findUnique({
    where: { stackUserId: stackUser.id },
  });
  if (byStackId) return byStackId;

  // 2. Lazy-link an existing local row by email (e.g. a backfill-skipped user).
  const email = stackUser.primaryEmail?.trim() || null;
  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail && !byEmail.stackUserId) {
      try {
        const linked = await prisma.user.update({
          where: { id: byEmail.id },
          data: { stackUserId: stackUser.id },
        });
        recordSignInMetric(false);
        return linked;
      } catch (e) {
        // A concurrent request may have linked it first; re-read by stackUserId.
        logger.warn(
          { err: e, "stack.user_id": stackUser.id },
          "auth: race linking local user by email",
        );
        const linked = await prisma.user.findUnique({
          where: { stackUserId: stackUser.id },
        });
        if (linked) return linked;
      }
    }
  }

  // 3. Create a minimal linked row. Only set email if it is free, so a
  //    duplicate-email Hexclave user cannot collide on the unique constraint.
  const emailIsFree =
    !!email && !(await prisma.user.findUnique({ where: { email } }));
  try {
    const created = await prisma.user.create({
      data: {
        stackUserId: stackUser.id,
        email: emailIsFree ? email : null,
        name: stackUser.displayName,
        image: stackUser.profileImageUrl,
      },
    });
    recordSignInMetric(true);
    return created;
  } catch (e) {
    // Unique race on stackUserId: another request created it first.
    const existing = await prisma.user.findUnique({
      where: { stackUserId: stackUser.id },
    });
    if (existing) return existing;
    throw e;
  }
}
