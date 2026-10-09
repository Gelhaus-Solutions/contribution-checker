import { App } from "@octokit/app";
import { getSecret } from "@/lib/vault/resolver";
import { budgetWrapper } from "@/lib/github/budget";

let cached: App | null = null;
let inflight: Promise<App> | null = null;

/**
 * Get the configured GitHub App. Throws if the GitHub App secrets aren't
 * resolvable from Vault or env. Octokit's App handles installation token
 * issuance and caching internally.
 *
 * Async because the secrets may live in Vault (resolved on demand).
 * Concurrent callers share one in-flight construction promise.
 */
export async function getGitHubApp(): Promise<App> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const [appId, privateKey, webhookSecret, clientId, clientSecret] =
      await Promise.all([
        getSecret("GITHUB_APP_ID"),
        getSecret("GITHUB_APP_PRIVATE_KEY"),
        getSecret("GITHUB_APP_WEBHOOK_SECRET"),
        getSecret("GITHUB_APP_CLIENT_ID"),
        getSecret("GITHUB_APP_CLIENT_SECRET"),
      ]);

    if (!appId || !privateKey || !webhookSecret) {
      throw new Error(
        "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET (env or Vault)."
      );
    }
    const app = new App({
      appId,
      privateKey: normalizePrivateKey(privateKey),
      webhooks: { secret: webhookSecret },
      ...(clientId && clientSecret
        ? { oauth: { clientId, clientSecret } }
        : {}),
    });
    cached = app;
    return app;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * Get an Octokit instance authenticated as a specific installation.
 * Use this for any repo-scoped GH API call.
 *
 * Every REST and GraphQL request made through it is accounted against the
 * installation's two-lane budget (see `budget.ts`): production traffic keeps
 * 75% of the quota, bulk work is held to 25%. Wrap background work in
 * `inBulkLane` to put it in the small lane.
 */
export async function getInstallationOctokit(installationId: number) {
  const app = await getGitHubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  octokit.hook.wrap("request", budgetWrapper(installationId));
  return octokit;
}

/** Drop the cached App so the next call re-resolves secrets (e.g. after rotation). */
export function invalidateGitHubAppCache(): void {
  cached = null;
}

const DEFAULT_APP_SLUG = "contribution-checker";

/**
 * Resolve the GitHub App slug (Vault → env → built-in default). Used by the
 * install-URL builder and a few admin display surfaces.
 */
export async function getAppSlug(): Promise<string> {
  const v = await getSecret("GITHUB_APP_SLUG");
  return v && v.length > 0 ? v : DEFAULT_APP_SLUG;
}

/**
 * GitHub App private keys are sometimes stored in env (or Vault) as a
 * single-line string with literal "\n" characters. Normalize back to real
 * newlines so the JWT signer accepts them.
 */
function normalizePrivateKey(key: string): string {
  if (key.includes("\\n")) return key.replace(/\\n/g, "\n");
  return key;
}
