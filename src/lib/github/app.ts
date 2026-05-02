import { App } from "@octokit/app";
import { env } from "@/lib/env";

let cached: App | null = null;

/**
 * Get the configured GitHub App. Throws if env vars aren't set.
 * Octokit's App handles installation token issuance and caching internally.
 */
export function getGitHubApp(): App {
  if (cached) return cached;
  if (!env.githubAppConfigured) {
    throw new Error(
      "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET."
    );
  }
  cached = new App({
    appId: env.GITHUB_APP_ID!,
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY!),
    webhooks: { secret: env.GITHUB_APP_WEBHOOK_SECRET! },
    ...(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
      ? {
          oauth: {
            clientId: env.GITHUB_APP_CLIENT_ID,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET,
          },
        }
      : {}),
  });
  return cached;
}

/**
 * Get an Octokit instance authenticated as a specific installation.
 * Use this for any repo-scoped GH API call.
 */
export async function getInstallationOctokit(installationId: number) {
  const app = getGitHubApp();
  return app.getInstallationOctokit(installationId);
}

/**
 * GitHub App private keys are sometimes stored in env as a single-line
 * string with literal "\n" characters. Normalize back to real newlines.
 */
function normalizePrivateKey(key: string): string {
  if (key.includes("\\n")) return key.replace(/\\n/g, "\n");
  return key;
}
