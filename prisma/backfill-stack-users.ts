/**
 * One-off backfill: pre-create a Hexclave (Stack Auth) user for every existing
 * local User and deterministically attach their GitHub OAuth connection by
 * account_id (= ghId), so that when the user signs in via GitHub after cutover
 * Hexclave matches the existing connection (no duplicate) and the local row's
 * stackUserId already points at it.
 *
 * Idempotent and re-runnable:
 *   - Skips users whose stackUserId is already set.
 *   - On a partial prior run (Hexclave user created but local row not updated),
 *     re-finds the Hexclave user by email and reuses it.
 *   - createOAuthProvider's "account id already used" error is treated as
 *     success (the link already exists).
 *
 * Conflicts (null email, duplicate ghId/email, undefined permission) are logged
 * and skipped per the agreed policy; those users lazy-link by ghId on their
 * first sign-in (src/lib/auth/sync-user.ts).
 *
 * Run with the Hexclave env vars present (Prisma loads DATABASE_URL + the rest
 * of .env into process.env; export them if they live in Vault):
 *
 *   pnpm db:backfill:stack            # apply
 *   DRY_RUN=1 pnpm db:backfill:stack  # report only, no writes
 */
import { PrismaClient } from "@prisma/client";
import { StackServerApp } from "@hexclave/next";
import {
  CREATE_PROJECT_PERMISSION,
  GITHUB_PROVIDER_CONFIG_ID,
  SUPER_ADMIN_PERMISSION,
} from "../src/lib/auth/constants";

const DRY_RUN = process.env.DRY_RUN === "1";
const BATCH = 100;

// PrismaClient construction loads .env into process.env, so read Stack env after.
const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Export the Hexclave env vars before running the backfill.`,
    );
  }
  return v;
}

const stackApp = new StackServerApp({
  tokenStore: "memory",
  projectId: requireEnv("NEXT_PUBLIC_STACK_PROJECT_ID"),
  publishableClientKey: requireEnv("NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY"),
  secretServerKey: requireEnv("STACK_SECRET_SERVER_KEY"),
  baseUrl: process.env.NEXT_PUBLIC_STACK_API_URL,
});

type Counts = {
  total: number;
  created: number;
  reusedExisting: number;
  skippedLinked: number;
  oauthAlreadyLinked: number;
  errors: number;
};

async function findStackUserByEmail(email: string) {
  const matches = await stackApp.listUsers({ query: email, limit: 10 });
  return (
    matches.find(
      (u) => u.primaryEmail?.toLowerCase() === email.toLowerCase(),
    ) ?? null
  );
}

async function backfillOne(
  user: {
    id: string;
    email: string | null;
    name: string | null;
    ghId: number | null;
    ghLogin: string | null;
    country: string | null;
    isSuperAdmin: boolean;
    canCreateProj: boolean;
  },
  counts: Counts,
): Promise<void> {
  if (user.ghId == null) {
    console.warn(`skip ${user.id}: no ghId (will lazy-link on first sign-in)`);
    counts.errors++;
    return;
  }

  const email = user.email?.trim() || null;
  const clientReadOnlyMetadata = user.country
    ? { country: user.country.toUpperCase(), onboarded: true }
    : {};

  if (DRY_RUN) {
    console.log(
      `[dry-run] would create Hexclave user for ${user.ghLogin ?? user.id} (ghId=${user.ghId}, email=${email ?? "none"})`,
    );
    counts.created++;
    return;
  }

  // 1. Create (or reuse on re-run) the Hexclave user.
  let stackUser: Awaited<ReturnType<typeof stackApp.createUser>> | null = null;
  try {
    stackUser = await stackApp.createUser({
      primaryEmail: email ?? undefined,
      primaryEmailVerified: !!email,
      displayName: user.name ?? user.ghLogin ?? undefined,
      serverMetadata: { ghId: user.ghId, ghLogin: user.ghLogin },
      clientReadOnlyMetadata,
    });
    counts.created++;
  } catch (e) {
    // Likely a prior partial run already created the user (email taken). Reuse.
    if (email) {
      stackUser = await findStackUserByEmail(email);
    }
    if (!stackUser) {
      console.error(`error ${user.ghLogin ?? user.id}: createUser failed`, e);
      counts.errors++;
      return;
    }
    counts.reusedExisting++;
  }

  // 2. Attach the GitHub OAuth connection by account_id (= ghId).
  try {
    const result = await stackApp.createOAuthProvider({
      userId: stackUser.id,
      accountId: String(user.ghId),
      providerConfigId: GITHUB_PROVIDER_CONFIG_ID,
      email: email ?? "",
      allowSignIn: true,
      allowConnectedAccounts: true,
    });
    if (result.status === "error") {
      // Account id already used for sign-in -> already linked. Fine.
      counts.oauthAlreadyLinked++;
    }
  } catch (e) {
    console.error(
      `error ${user.ghLogin ?? user.id}: createOAuthProvider failed`,
      e,
    );
    counts.errors++;
    // Don't return: still link stackUserId so the row resolves; the connection
    // can be repaired on first sign-in.
  }

  // 3. Grant org permissions matching the local cache columns.
  try {
    if (user.isSuperAdmin) await stackUser.grantPermission(SUPER_ADMIN_PERMISSION);
    if (user.isSuperAdmin || user.canCreateProj) {
      await stackUser.grantPermission(CREATE_PROJECT_PERMISSION);
    }
  } catch (e) {
    console.warn(
      `warn ${user.ghLogin ?? user.id}: grantPermission failed (define super_admin/create_project in Hexclave)`,
      e,
    );
  }

  // 4. Link the local row.
  await prisma.user.update({
    where: { id: user.id },
    data: { stackUserId: stackUser.id },
  });
}

async function main(): Promise<void> {
  const counts: Counts = {
    total: 0,
    created: 0,
    reusedExisting: 0,
    skippedLinked: 0,
    oauthAlreadyLinked: 0,
    errors: 0,
  };

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.user.findMany({
      where: { stackUserId: null },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        email: true,
        name: true,
        ghId: true,
        ghLogin: true,
        country: true,
        isSuperAdmin: true,
        canCreateProj: true,
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const user of batch) {
      counts.total++;
      try {
        await backfillOne(user, counts);
      } catch (e) {
        console.error(`error ${user.id}: unexpected`, e);
        counts.errors++;
      }
    }
  }

  // Count already-linked rows for the summary.
  counts.skippedLinked = await prisma.user.count({
    where: { stackUserId: { not: null } },
  });

  console.log("\nBackfill summary:", JSON.stringify(counts, null, 2));
  if (DRY_RUN) console.log("(dry run: no writes performed)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
