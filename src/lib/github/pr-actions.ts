import { getInstallationOctokit } from "@/lib/github/app";
import { logger } from "@/lib/logger";

type RepoRef = { owner: string; repo: string; installationId: number };

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo full name: ${fullName}`);
  return { owner, repo };
}

export function repoRef(fullName: string, installationId: number): RepoRef {
  const { owner, repo } = splitFullName(fullName);
  return { owner, repo, installationId };
}

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export async function closePullRequest(
  ref: RepoRef,
  prNumber: number,
  comment?: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  if (comment) {
    await octokit
      .request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        body: comment,
      })
      .catch((e: unknown) =>
        logger.warn({ err: e, ref, prNumber }, "create-comment failed")
      );
  }
  await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
    state: "closed",
  });
}

export async function reopenPullRequest(
  ref: RepoRef,
  prNumber: number,
  comment?: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
    state: "open",
  });
  if (comment) {
    await octokit
      .request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        body: comment,
      })
      .catch((e: unknown) =>
        logger.warn({ err: e, ref, prNumber }, "create-comment failed")
      );
  }
}

export async function ensureLabel(
  ref: RepoRef,
  name: string,
  color = "ededed",
  description?: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner: ref.owner,
      repo: ref.repo,
      name,
    });
  } catch (e) {
    if (statusOf(e) === 404) {
      await octokit
        .request("POST /repos/{owner}/{repo}/labels", {
          owner: ref.owner,
          repo: ref.repo,
          name,
          color,
          description,
        })
        .catch((createErr: unknown) =>
          logger.debug({ err: createErr }, "label create race")
        );
    } else {
      throw e;
    }
  }
}

export async function setLabels(
  ref: RepoRef,
  prNumber: number,
  labels: string[]
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: prNumber,
    labels,
  });
}

export async function addLabel(
  ref: RepoRef,
  prNumber: number,
  label: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: prNumber,
    labels: [label],
  });
}

export async function removeLabelIfPresent(
  ref: RepoRef,
  prNumber: number,
  label: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit
    .request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        name: label,
      }
    )
    .catch((e: unknown) => {
      if (statusOf(e) !== 404) throw e;
    });
}

export async function commentOnPr(
  ref: RepoRef,
  prNumber: number,
  body: string
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      body,
    }
  );
}

// ----- Check Runs -----

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale";

export type CheckRunInput = {
  headSha: string;
  name: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
  text?: string;
};

/**
 * Create a Check Run, or update the existing one if `existingId` is provided.
 * Returns the Check Run id (as a string) so callers can persist it.
 */
export async function upsertCheckRun(
  ref: RepoRef,
  input: CheckRunInput,
  existingId: string | null
): Promise<string | null> {
  const octokit = await getInstallationOctokit(ref.installationId);
  const body = {
    name: input.name,
    head_sha: input.headSha,
    status: input.status,
    ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    output: {
      title: input.title,
      summary: input.summary,
      ...(input.text ? { text: input.text } : {}),
    },
  };
  try {
    if (existingId) {
      const res = await octokit.request(
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        {
          owner: ref.owner,
          repo: ref.repo,
          check_run_id: Number(existingId),
          ...body,
        }
      );
      return String((res.data as { id: number | string }).id);
    }
    const res = await octokit.request(
      "POST /repos/{owner}/{repo}/check-runs",
      { owner: ref.owner, repo: ref.repo, ...body }
    );
    return String((res.data as { id: number | string }).id);
  } catch (e) {
    if (statusOf(e) === 403 || statusOf(e) === 404) {
      logger.warn(
        { err: e, ref, headSha: input.headSha },
        "check-run publish forbidden — installation likely missing checks:write"
      );
      return null;
    }
    throw e;
  }
}

const checksPermCache = new Map<number, { value: boolean; expiresAt: number }>();
const CHECKS_PERM_TTL_MS = 5 * 60 * 1000;

/**
 * Feature-detect whether the installation grants `checks:write`. Cached
 * 5 min per installation. Used to avoid 403s and to silently no-op when
 * permission isn't granted (existing installs that haven't accepted).
 */
export async function installationHasChecksWrite(
  installationId: number
): Promise<boolean> {
  const now = Date.now();
  const hit = checksPermCache.get(installationId);
  if (hit && hit.expiresAt > now) return hit.value;
  const octokit = await getInstallationOctokit(installationId);
  try {
    const res = await octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    });
    const perms = (res.data as { permissions?: Record<string, string> }).permissions;
    const value = perms?.checks === "write";
    checksPermCache.set(installationId, {
      value,
      expiresAt: now + CHECKS_PERM_TTL_MS,
    });
    return value;
  } catch (e) {
    logger.warn({ err: e, installationId }, "checks-perm probe failed");
    checksPermCache.set(installationId, {
      value: false,
      expiresAt: now + CHECKS_PERM_TTL_MS,
    });
    return false;
  }
}
