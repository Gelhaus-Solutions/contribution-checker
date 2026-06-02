/**
 * One-off backfill + reconcile for Hexclave (Stack Auth) users.
 *
 * For every local User it pre-creates a Hexclave user and deterministically
 * attaches the GitHub OAuth connection by account_id (= ghId), so that on first
 * GitHub sign-in Hexclave matches the existing connection (no duplicate) and the
 * local row's stackUserId already points at it.
 *
 * It is also a RECONCILER: re-running it processes ALL users (not just unlinked
 * ones) and fixes the primary-email "verified" flag to match what we actually
 * know (local User.emailVerified). We do NOT claim an email is verified just
 * because GitHub gave us one. (An earlier version set verified=true for every
 * user with an email; re-run this to correct them.)
 *
 * Idempotent and re-runnable:
 *   - Already-linked users are fetched and reconciled (verified flag,
 *     permissions, OAuth link), not recreated.
 *   - On a partial prior run (Hexclave user created but local row not updated),
 *     re-finds the Hexclave user by email and reuses it.
 *   - createOAuthProvider's "account id already used" error means it's already
 *     linked -> fine.
 *
 * Users with no ghId are skipped (they lazy-link by ghId on first sign-in,
 * src/lib/auth/sync-user.ts).
 *
 * Run with the Hexclave env vars present (Prisma loads DATABASE_URL + the rest
 * of .env into process.env; export them if they live in Vault):
 *
 *   pnpm db:backfill:stack            # apply
 *   DRY_RUN=1 pnpm db:backfill:stack  # report only, no writes
 */
import { PrismaClient } from "@prisma/client";
import { StackServerApp, type ServerUser } from "@hexclave/next";

// Inlined (not imported from src/lib/auth/constants) so this script stays
// self-contained: the production Docker image ships the built app + prisma/,
// not the src/ tree. Keep these in sync with src/lib/auth/constants.ts.
const SUPER_ADMIN_PERMISSION = "super_admin";
const CREATE_PROJECT_PERMISSION = "create_project";
const GITHUB_PROVIDER_CONFIG_ID = "github";

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
  projectId: requireEnv("STACK_PROJECT_ID"),
  publishableClientKey: requireEnv("STACK_PUBLISHABLE_CLIENT_KEY"),
  secretServerKey: requireEnv("STACK_SECRET_SERVER_KEY"),
  baseUrl: process.env.STACK_API_URL,
});

type Counts = {
  total: number;
  created: number;
  reconciled: number;
  reusedExisting: number;
  oauthAlreadyLinked: number;
  emailVerifiedFixed: number;
  errors: number;
};

type LocalUser = {
  id: string;
  stackUserId: string | null;
  email: string | null;
  emailVerified: Date | null;
  name: string | null;
  ghId: number | null;
  ghLogin: string | null;
  country: string | null;
  isSuperAdmin: boolean;
  canCreateProj: boolean;
};

async function findStackUserByEmail(email: string): Promise<ServerUser | null> {
  const matches = await stackApp.listUsers({ query: email, limit: 10 });
  return (
    matches.find(
      (u) => u.primaryEmail?.toLowerCase() === email.toLowerCase(),
    ) ?? null
  );
}

async function backfillOne(user: LocalUser, counts: Counts): Promise<void> {
  if (user.ghId == null) {
    console.warn(`skip ${user.id}: no ghId (will lazy-link on first sign-in)`);
    counts.errors++;
    return;
  }

  const email = user.email?.trim() || null;
  // We only assert email verification we actually have (local emailVerified).
  // GitHub giving us an address does NOT mean it's verified.
  const desiredVerified = !!user.emailVerified;
  // User.country is captured in the background from geo on first sign-in.
  const clientReadOnlyMetadata = user.country
    ? { country: user.country.toUpperCase() }
    : {};

  // Resolve the existing Hexclave user when already linked (read-only).
  let stackUser: ServerUser | null = user.stackUserId
    ? await stackApp.getUser(user.stackUserId)
    : null;

  if (DRY_RUN) {
    if (stackUser) {
      const willFix = stackUser.primaryEmailVerified !== desiredVerified;
      console.log(
        `[dry-run] reconcile ${user.ghLogin ?? user.id}: verified ${stackUser.primaryEmailVerified} -> ${desiredVerified}${willFix ? " (FIX)" : ""}`,
      );
      counts.reconciled++;
      if (willFix) counts.emailVerifiedFixed++;
    } else {
      console.log(
        `[dry-run] would create ${user.ghLogin ?? user.id} (ghId=${user.ghId}, verified=${desiredVerified})`,
      );
      counts.created++;
    }
    return;
  }

  // 1. Create the Hexclave user if it doesn't exist yet.
  if (!stackUser) {
    try {
      stackUser = await stackApp.createUser({
        primaryEmail: email ?? undefined,
        primaryEmailVerified: desiredVerified,
        displayName: user.name ?? user.ghLogin ?? undefined,
        serverMetadata: { ghId: user.ghId, ghLogin: user.ghLogin },
        clientReadOnlyMetadata,
      });
      counts.created++;
    } catch (e) {
      // Likely a prior partial run already created the user (email taken). Reuse.
      if (email) stackUser = await findStackUserByEmail(email);
      if (!stackUser) {
        console.error(`error ${user.ghLogin ?? user.id}: createUser failed`, e);
        counts.errors++;
        return;
      }
      counts.reusedExisting++;
    }
  } else {
    counts.reconciled++;
  }

  // 2. Attach the GitHub OAuth connection by account_id (= ghId). Idempotent.
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
      counts.oauthAlreadyLinked++; // account id already used -> already linked.
    }
  } catch (e) {
    console.error(
      `error ${user.ghLogin ?? user.id}: createOAuthProvider failed`,
      e,
    );
    counts.errors++;
  }

  // 3. Reconcile the email "verified" flag to the truth. Fixes users that an
  //    earlier run wrongly marked verified. Only writes when it differs.
  try {
    if (stackUser.primaryEmailVerified !== desiredVerified) {
      await stackUser.update({ primaryEmailVerified: desiredVerified });
      counts.emailVerifiedFixed++;
    }
  } catch (e) {
    console.warn(
      `warn ${user.ghLogin ?? user.id}: could not update primaryEmailVerified`,
      e,
    );
  }

  // 4. Grant org permissions matching the local cache columns.
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

  // 5. Link the local row if not already linked.
  if (!user.stackUserId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { stackUserId: stackUser.id },
    });
  }
}

async function main(): Promise<void> {
  const counts: Counts = {
    total: 0,
    created: 0,
    reconciled: 0,
    reusedExisting: 0,
    oauthAlreadyLinked: 0,
    emailVerifiedFixed: 0,
    errors: 0,
  };

  let cursor: string | undefined;
  for (;;) {
    const batch: LocalUser[] = await prisma.user.findMany({
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        stackUserId: true,
        email: true,
        emailVerified: true,
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
