import { getInstallationOctokit } from "@/lib/github/app";

const cache = new Map<string, { value: boolean; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

/**
 * Check if `ghLogin` is a collaborator on the given repo. Cached per
 * repo+login for 5 minutes. Used to auto-bypass repo collaborators.
 *
 * Note: GitHub returns 204 if the user IS a collaborator and 404 otherwise.
 */
export async function isCollaborator(args: {
  installationId: number;
  owner: string;
  repo: string;
  ghLogin: string;
}): Promise<boolean> {
  const key = `${args.owner}/${args.repo}#${args.ghLogin.toLowerCase()}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const octokit = await getInstallationOctokit(args.installationId);
  let value = false;
  try {
    await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}",
      {
        owner: args.owner,
        repo: args.repo,
        username: args.ghLogin,
      }
    );
    value = true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) value = false;
    else throw e;
  }
  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}
