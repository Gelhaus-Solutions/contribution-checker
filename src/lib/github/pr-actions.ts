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
