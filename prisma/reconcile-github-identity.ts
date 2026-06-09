/**
 * One-off repair for users stuck without a GitHub identity after the Hexclave
 * migration.
 *
 * Symptom it fixes: every user who signed up after the NextAuth -> Hexclave swap
 * has `ghId`/`ghLogin` NULL because the old onboarding learned ghId by minting a
 * connected-account access token, which is unavailable when Hexclave's GitHub
 * provider runs on shared OAuth keys. With ghId NULL, requireSession() bounces
 * them to /welcome forever (effectively "no login").
 *
 * This reads the GitHub numeric id straight from Stack's stored OAuth provider
 * link (`getOAuthProvider("github").accountId`) and resolves the login via the
 * public `GET /user/{id}` endpoint (no token needed), then writes ghId/ghLogin
 * onto the local row. It mirrors the runtime fix in src/lib/auth/sync-user.ts,
 * including the merge-by-ghId safety, so re-running is safe.
 *
 * Only processes rows with stackUserId set and ghId NULL. Idempotent: once a row
 * has ghId it is no longer selected.
 *
 *   pnpm db:reconcile:github            # apply
 *   DRY_RUN=1 pnpm db:reconcile:github  # report only, no writes
 */
import { PrismaClient } from "@prisma/client";
import { StackServerApp } from "@hexclave/next";

// Inlined so the script stays self-contained (the prod image ships built app +
// prisma/, not src/). Keep in sync with src/lib/auth/constants.ts.
const GITHUB_PROVIDER_CONFIG_ID = "github";

const DRY_RUN = process.env.DRY_RUN === "1";
const BATCH = 100;

const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Export the Hexclave env vars before running this script.`,
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

type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
};

/** Resolve a GitHub account's public profile by numeric id (no token needed). */
async function fetchGithubUserById(id: number): Promise<GithubUser | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "contribution-checker",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/user/${id}`, { headers });
  if (!res.ok) {
    console.warn(`  GitHub /user/${id} failed: ${res.status}`);
    return null;
  }
  return (await res.json()) as GithubUser;
}

type Counts = {
  total: number;
  fixed: number;
  merged: number;
  noStackUser: number;
  noGithubLink: number;
  errors: number;
};

type LocalUser = {
  id: string;
  stackUserId: string;
  email: string | null;
};

async function reconcileOne(user: LocalUser, counts: Counts): Promise<void> {
  const label = user.email ?? user.id;

  const stackUser = await stackApp.getUser(user.stackUserId);
  if (!stackUser) {
    console.warn(`skip ${label}: no Hexclave user for ${user.stackUserId}`);
    counts.noStackUser++;
    return;
  }

  // Match on provider `type` ("github"). getOAuthProvider(id) keys on the
  // per-connection instance id, not the provider type, so it never finds it.
  const providers = await stackUser.listOAuthProviders();
  const provider = providers.find(
    (p) => p.type === GITHUB_PROVIDER_CONFIG_ID && p.accountId,
  );
  const accountId = provider?.accountId?.trim();
  if (!accountId) {
    console.warn(`skip ${label}: no GitHub provider linked in Hexclave`);
    counts.noGithubLink++;
    return;
  }
  const ghId = Number(accountId);
  if (!Number.isInteger(ghId) || ghId <= 0) {
    console.warn(`skip ${label}: GitHub accountId not numeric (${accountId})`);
    counts.errors++;
    return;
  }

  const gh = await fetchGithubUserById(ghId);
  const ghLogin = gh?.login || null;
  const ghName = gh?.name ?? null;
  const ghAvatar = gh?.avatar_url ?? null;

  if (DRY_RUN) {
    console.log(
      `[dry-run] ${label}: ghId=${ghId} ghLogin=${ghLogin ?? "(unresolved)"}`,
    );
    counts.fixed++;
    return;
  }

  // Merge-by-ghId: if another local row already owns this ghId, re-point the
  // Hexclave link to it and drop this (relation-less) row.
  const owner = await prisma.user.findUnique({ where: { ghId } });
  if (owner && owner.id !== user.id) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { stackUserId: null },
      });
      await tx.user.update({
        where: { id: owner.id },
        data: {
          stackUserId: user.stackUserId,
          // Only fill ghLogin if the existing row lacks it; never clobber.
          ...(ghLogin && !owner.ghLogin ? { ghLogin } : {}),
        },
      });
      await tx.user.delete({ where: { id: user.id } }).catch(() => {});
    });
    console.log(`merged ${label} -> existing ghId row ${owner.id}`);
    counts.merged++;
    return;
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ghId,
        ...(ghLogin ? { ghLogin } : {}),
        ...(ghName ? { name: ghName } : {}),
        ...(ghAvatar ? { image: ghAvatar } : {}),
      },
    });
  } catch (e) {
    // ghLogin unique collision -> persist ghId alone (the gating field).
    console.warn(`${label}: full update failed, writing ghId only`, e);
    await prisma.user.update({ where: { id: user.id }, data: { ghId } });
  }
  console.log(`fixed ${label}: ghId=${ghId} ghLogin=${ghLogin ?? "(null)"}`);
  counts.fixed++;
}

async function main(): Promise<void> {
  const counts: Counts = {
    total: 0,
    fixed: 0,
    merged: 0,
    noStackUser: 0,
    noGithubLink: 0,
    errors: 0,
  };

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.user.findMany({
      where: { ghId: null, stackUserId: { not: null } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, stackUserId: true, email: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const user of batch) {
      counts.total++;
      try {
        // stackUserId is non-null by the where filter; assert for the type.
        await reconcileOne(user as LocalUser, counts);
      } catch (e) {
        console.error(`error ${user.id}: unexpected`, e);
        counts.errors++;
      }
    }
  }

  console.log("\nReconcile summary:", JSON.stringify(counts, null, 2));
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
