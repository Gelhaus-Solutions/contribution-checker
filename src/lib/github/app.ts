import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { getSecret } from "@/lib/vault/resolver";
import { budgetWrapper } from "@/lib/github/budget";
import {
  gmintTokens,
  type GithubTenant,
  type TokenNeed,
} from "@/lib/github/gmint-tokens";

let cached: App | null = null;
let inflight: Promise<App> | null = null;

/**
 * Get the configured GitHub App. Throws if the GitHub App secrets aren't
 * resolvable from Vault or env. Octokit's App handles installation token
 * issuance and caching internally.
 *
 * Only for an App that mints with its own key. GMint holds the key of an App
 * listed in `GMINT_GITHUB_APP_IDS` and never signs App JWTs for anyone, so for
 * that App there is no App object here at all, and nothing App-level
 * (`GET /app`, listing installations, `eachInstallation`) can be done.
 *
 * Async because the secrets may live in Vault (resolved on demand).
 * Concurrent callers share one in-flight construction promise.
 */
export async function getGitHubApp(): Promise<App> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    // The id first, so the key of an App GMint holds is never even read.
    const appId = await getSecret("GITHUB_APP_ID");
    if (appId && gmintTokens().manages(appId)) {
      throw new Error(
        `GMint holds the key of GitHub App ${appId}: its installation tokens come from GMint, and App-level calls (the App JWT) are not available.`,
      );
    }
    const [privateKey, webhookSecret, clientId, clientSecret] =
      await Promise.all([
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
 * Whether this instance's GitHub App gets its installation tokens from GMint
 * (its id is in `GMINT_GITHUB_APP_IDS`). False while the App id is unset.
 */
export async function appTokensFromGmint(): Promise<boolean> {
  const appId = await getSecret("GITHUB_APP_ID");
  return !!appId && gmintTokens().manages(appId);
}

/**
 * Get an Octokit instance authenticated as a specific installation.
 * Use this for any repo-scoped GH API call.
 *
 * Every caller names its `need`: the GMint purpose, the repositories by name
 * within the installation (none for an org-scoped token) and the permissions
 * (`metadata: read` is implied), and the `tenant` the work is for. For an App
 * whose key GMint holds, the token is GMint's for exactly that need, and a
 * request outside it fails on GitHub's side. For any other App the need is not
 * used: the token is the installation's own, minted with the App's key.
 *
 * Every REST and GraphQL request made through it is accounted against the
 * installation's two-lane budget (see `budget.ts`): production traffic keeps
 * 75% of the quota, bulk work is held to 25%. Wrap background work in
 * `inBulkLane` to put it in the small lane.
 */
export async function getInstallationOctokit(
  installationId: number,
  need: TokenNeed,
  tenant: GithubTenant,
) {
  const octokit = (await appTokensFromGmint())
    ? await gmintInstallationOctokit(installationId, need, tenant)
    : await (await getGitHubApp()).getInstallationOctokit(installationId);
  octokit.hook.wrap("request", budgetWrapper(installationId));
  return octokit;
}

/**
 * An installation Octokit whose token is GMint's. The token is taken before
 * the first request, so a refusal surfaces here exactly where a failed mint
 * with the App's key would, and again per request from the reuse cache, so a
 * long-lived instance never sends one that has run out. A 401 from GitHub drops
 * the installation's cached tokens: the next request mints afresh.
 */
async function gmintInstallationOctokit(
  installationId: number,
  need: TokenNeed,
  tenant: GithubTenant,
): Promise<Octokit> {
  const tokens = gmintTokens();
  await tokens.token(installationId, need, tenant);
  return new Octokit({
    authStrategy: () => {
      const auth = async () => ({ type: "token", tokenType: "installation" });
      return Object.assign(auth, {
        hook: async (
          request: RequestWithEndpoint,
          route: string | Record<string, unknown>,
          parameters?: Record<string, unknown>,
        ) => {
          const endpoint = request.endpoint.merge(route, parameters);
          endpoint.headers.authorization = `token ${await tokens.token(
            installationId,
            need,
            tenant,
          )}`;
          try {
            return await request(endpoint);
          } catch (e) {
            if ((e as { status?: unknown })?.status === 401) {
              tokens.forget(installationId);
            }
            throw e;
          }
        },
      });
    },
  });
}

type RequestWithEndpoint = ((
  options: Record<string, unknown>,
) => Promise<unknown>) & {
  endpoint: {
    merge: (
      route: string | Record<string, unknown>,
      parameters?: Record<string, unknown>,
    ) => Record<string, unknown> & { headers: Record<string, string> };
  };
};

/**
 * Drop the cached App so the next call re-resolves secrets (e.g. after
 * rotation), and every cached GMint token with it.
 */
export function invalidateGitHubAppCache(): void {
  cached = null;
  gmintTokens().forgetAll();
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
