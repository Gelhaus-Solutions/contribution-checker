import * as Sentry from "@sentry/nextjs";
import { getInstallationOctokit } from "@/lib/github/app";
import { logger } from "@/lib/logger";

export type RepoRef = { owner: string; repo: string; installationId: number };

function recordGithubMetric(
  op: string,
  outcome: "ok" | "error",
  ref: RepoRef,
  status?: number,
): void {
  Sentry.metrics.count("github.api_call", 1, {
    attributes: {
      "github.op": op,
      "github.repo": `${ref.owner}/${ref.repo}`,
      "github.installation_id": ref.installationId,
      outcome,
      ...(status != null ? { "github.status": status } : {}),
    },
  });
}

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
  comment?: string,
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
      .then(() => recordGithubMetric("issue.comment", "ok", ref))
      .catch((e: unknown) => {
        recordGithubMetric("issue.comment", "error", ref, statusOf(e));
        logger.warn({ err: e, ref, prNumber }, "create-comment failed");
      });
  }
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      state: "closed",
    });
    recordGithubMetric("pr.close", "ok", ref);
  } catch (e) {
    recordGithubMetric("pr.close", "error", ref, statusOf(e));
    throw e;
  }
}

export async function reopenPullRequest(
  ref: RepoRef,
  prNumber: number,
  comment?: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      state: "open",
    });
    recordGithubMetric("pr.reopen", "ok", ref);
  } catch (e) {
    recordGithubMetric("pr.reopen", "error", ref, statusOf(e));
    throw e;
  }
  if (comment) {
    await octokit
      .request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        body: comment,
      })
      .then(() => recordGithubMetric("issue.comment", "ok", ref))
      .catch((e: unknown) => {
        recordGithubMetric("issue.comment", "error", ref, statusOf(e));
        logger.warn({ err: e, ref, prNumber }, "create-comment failed");
      });
  }
}

/** The PR fields the staging routing and batch reconcile paths need. */
export type PrSummary = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  /** The commit the merge produced on the base branch, for batch membership. */
  mergeCommitSha: string | null;
  body: string | null;
  baseRef: string;
  headRef: string;
  authorLogin: string | null;
  labels: string[];
};

type RawPr = {
  number: number;
  title?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  body?: string | null;
  base?: { ref?: string };
  head?: { ref?: string };
  user?: { login?: string } | null;
  labels?: Array<{ name?: string }>;
};

function toPrSummary(raw: RawPr): PrSummary {
  return {
    number: raw.number,
    title: raw.title ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    // The list endpoint omits `merged`; `merged_at` is present on both.
    merged: raw.merged ?? raw.merged_at != null,
    mergedAt: raw.merged_at ?? null,
    mergeCommitSha: raw.merge_commit_sha ?? null,
    body: raw.body ?? null,
    baseRef: raw.base?.ref ?? "",
    headRef: raw.head?.ref ?? "",
    authorLogin: raw.user?.login ?? null,
    labels: (raw.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

/**
 * Repoint an open PR at a different base branch. GitHub recomputes the merge
 * base, so the PR's diff can change; that is inherent to retargeting.
 * Idempotent: setting the base a PR already has is accepted and is a no-op.
 */
export async function setPullRequestBase(
  ref: RepoRef,
  prNumber: number,
  base: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      base,
    });
    recordGithubMetric("pr.set_base", "ok", ref);
  } catch (e) {
    recordGithubMetric("pr.set_base", "error", ref, statusOf(e));
    throw e;
  }
}

/** Read one PR. Returns null on 404 (deleted/transferred) rather than throwing. */
export async function getPullRequest(
  ref: RepoRef,
  prNumber: number,
): Promise<PrSummary | null> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner: ref.owner, repo: ref.repo, pull_number: prNumber },
    );
    recordGithubMetric("pr.get", "ok", ref);
    return toPrSummary(res.data as RawPr);
  } catch (e) {
    recordGithubMetric("pr.get", "error", ref, statusOf(e));
    if (statusOf(e) === 404) return null;
    throw e;
  }
}

/** Page size and page cap for PR listing, mirroring checkDco and quality/fetch. */
const PR_PAGE_SIZE = 100;
const PR_PAGE_LIMIT = 3;

/**
 * List PRs, following pages up to PR_PAGE_LIMIT (300 PRs). `head` must be
 * `owner:branch`. Sorted newest-updated first so the cap keeps the most
 * relevant page when a repo blows past it.
 */
export async function listPullRequests(
  ref: RepoRef,
  opts: { base?: string; head?: string; state?: "open" | "closed" | "all" },
): Promise<PrSummary[]> {
  const octokit = await getInstallationOctokit(ref.installationId);
  const out: PrSummary[] = [];
  try {
    for (let page = 1; page <= PR_PAGE_LIMIT; page++) {
      const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: ref.owner,
        repo: ref.repo,
        state: opts.state ?? "open",
        ...(opts.base ? { base: opts.base } : {}),
        ...(opts.head ? { head: opts.head } : {}),
        sort: "updated",
        direction: "desc",
        per_page: PR_PAGE_SIZE,
        page,
      });
      const batch = res.data as RawPr[];
      for (const raw of batch) out.push(toPrSummary(raw));
      if (batch.length < PR_PAGE_SIZE) break;
    }
    recordGithubMetric("pr.list", "ok", ref);
    return out;
  } catch (e) {
    recordGithubMetric("pr.list", "error", ref, statusOf(e));
    throw e;
  }
}

/** Why a createPullRequest call did not produce a PR. */
export type CreatePrFailure = "no_commits" | "already_exists" | "forbidden";

/**
 * Open a PR, ready for review. The two 422s GitHub returns here are ordinary
 * states rather than errors, so they come back as a typed reason instead of a
 * throw: "no commits between" (nothing to ship) and "a pull request already
 * exists" (a concurrent reconcile won the race).
 */
export async function createPullRequest(
  ref: RepoRef,
  input: { title: string; head: string; base: string; body: string },
): Promise<{ number: number } | { failure: CreatePrFailure }> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: ref.owner,
      repo: ref.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    });
    recordGithubMetric("pr.create", "ok", ref);
    return { number: (res.data as { number: number }).number };
  } catch (e) {
    const status = statusOf(e);
    recordGithubMetric("pr.create", "error", ref, status);
    if (status === 403) return { failure: "forbidden" };
    if (status === 422) {
      const msg = JSON.stringify(
        (e as { response?: { data?: unknown } }).response?.data ?? "",
      ).toLowerCase();
      if (msg.includes("no commits between")) return { failure: "no_commits" };
      if (msg.includes("already exists")) return { failure: "already_exists" };
    }
    throw e;
  }
}

/** Replace a PR's description. Callers must diff first: every call is an edit
 * in the PR's timeline, so an unconditional rewrite is visible noise. */
export async function updatePullRequestBody(
  ref: RepoRef,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      body,
    });
    recordGithubMetric("pr.update_body", "ok", ref);
  } catch (e) {
    recordGithubMetric("pr.update_body", "error", ref, statusOf(e));
    throw e;
  }
}

/**
 * How far `head` is ahead of `base`, plus the date of their merge base.
 *
 * `commitShas` is the batch membership set the staging reconciler needs: a PR
 * ships in this batch exactly when its merge commit is one of these. It
 * replaces `mergeBaseDate` as the cutoff, which was only ever a proxy for
 * membership and a bad one, because syncing the default branch into staging
 * moves the merge base to a commit created seconds ago and so excludes every
 * PR merged before it. `mergeBaseDate` is kept for the truncated case below.
 *
 * GitHub inlines at most 250 commits in a compare; `truncated` says the SHA
 * set is incomplete, so callers must not read absence as exclusion.
 *
 * Returns null when either branch is missing (404), the "staging does not
 * exist yet" case.
 */
export async function compareBranches(
  ref: RepoRef,
  base: string,
  head: string,
): Promise<{
  aheadBy: number;
  behindBy: number;
  mergeBaseDate: string | null;
  commitShas: string[];
  /** sha -> parent shas, for telling a merge apart from what it merged. */
  commitParents: Record<string, string[]>;
  truncated: boolean;
} | null> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      { owner: ref.owner, repo: ref.repo, basehead: `${base}...${head}` },
    );
    recordGithubMetric("repo.compare", "ok", ref);
    const data = res.data as {
      ahead_by?: number;
      behind_by?: number;
      total_commits?: number;
      commits?: Array<{ sha?: string; parents?: Array<{ sha?: string }> }>;
      merge_base_commit?: { commit?: { committer?: { date?: string } } };
    };
    const commits = (data.commits ?? []).filter(
      (c): c is { sha: string; parents?: Array<{ sha?: string }> } =>
        typeof c.sha === "string" && c.sha.length > 0,
    );
    const commitShas = commits.map((c) => c.sha);
    const commitParents: Record<string, string[]> = {};
    for (const c of commits) {
      commitParents[c.sha] = (c.parents ?? [])
        .map((p) => p.sha)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
    }
    return {
      aheadBy: data.ahead_by ?? 0,
      behindBy: data.behind_by ?? 0,
      mergeBaseDate: data.merge_base_commit?.commit?.committer?.date ?? null,
      commitShas,
      commitParents,
      truncated: (data.total_commits ?? commitShas.length) > commitShas.length,
    };
  } catch (e) {
    recordGithubMetric("repo.compare", "error", ref, statusOf(e));
    if (statusOf(e) === 404) return null;
    throw e;
  }
}

/** Head SHA of a branch, or null when the branch does not exist. */
export async function getBranchSha(
  ref: RepoRef,
  branch: string,
): Promise<string | null> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      { owner: ref.owner, repo: ref.repo, ref: `heads/${branch}` },
    );
    recordGithubMetric("git.get_ref", "ok", ref);
    return (res.data as { object?: { sha?: string } }).object?.sha ?? null;
  } catch (e) {
    recordGithubMetric("git.get_ref", "error", ref, statusOf(e));
    if (statusOf(e) === 404) return null;
    throw e;
  }
}

/**
 * Create a branch at `sha`. Needs `contents:write`, which older installations
 * have not granted: a 403 returns false rather than throwing so the caller can
 * degrade instead of wedging. An existing ref (422) counts as success.
 */
export async function createBranch(
  ref: RepoRef,
  branch: string,
  sha: string,
): Promise<boolean> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: ref.owner,
      repo: ref.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
    recordGithubMetric("git.create_ref", "ok", ref);
    return true;
  } catch (e) {
    const status = statusOf(e);
    recordGithubMetric("git.create_ref", "error", ref, status);
    if (status === 422) return true; // already exists; a concurrent run won
    if (status === 403) {
      logger.warn(
        { ref, branch },
        "branch create forbidden: installation likely missing contents:write",
      );
      return false;
    }
    throw e;
  }
}

/**
 * Fast-forward a branch to `sha`. Never forced: GitHub rejects the update with
 * 422 when it would not be a fast-forward, which is the guard that keeps this
 * from ever discarding commits. Returns false on a rejected or forbidden
 * update so the caller can fall back to a merge.
 */
export async function fastForwardBranch(
  ref: RepoRef,
  branch: string,
  sha: string,
): Promise<boolean> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${branch}`,
      sha,
      force: false,
    });
    recordGithubMetric("git.update_ref", "ok", ref);
    return true;
  } catch (e) {
    const status = statusOf(e);
    recordGithubMetric("git.update_ref", "error", ref, status);
    if (status === 422 || status === 403 || status === 404) return false;
    throw e;
  }
}

/** Why a mergeBranch call did not produce a merge. */
export type MergeFailure = "conflict" | "forbidden" | "missing";

/**
 * Merge `head` into `base` server-side, with no PR. Creates a merge commit, so
 * it never rewrites history. GitHub's 204 means "already up to date", which is
 * success with nothing to do rather than an error.
 */
export async function mergeBranch(
  ref: RepoRef,
  base: string,
  head: string,
  commitMessage: string,
): Promise<{ merged: boolean } | { failure: MergeFailure }> {
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request("POST /repos/{owner}/{repo}/merges", {
      owner: ref.owner,
      repo: ref.repo,
      base,
      head,
      commit_message: commitMessage,
    });
    recordGithubMetric("repo.merge", "ok", ref);
    // 204 = nothing to merge; 201 = a merge commit was created.
    return { merged: res.status === 201 };
  } catch (e) {
    const status = statusOf(e);
    recordGithubMetric("repo.merge", "error", ref, status);
    if (status === 409) return { failure: "conflict" };
    if (status === 403) return { failure: "forbidden" };
    if (status === 404) return { failure: "missing" };
    throw e;
  }
}

const defaultBranchCache = new Map<string, { value: string; expiresAt: number }>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

/**
 * The repo's default branch, cached 5 min. Only reached when neither the
 * webhook payload nor the Repo.defaultBranch column could answer, so a cache
 * miss is rare. Returns null on any failure: callers must treat an unknown
 * default branch as "do not retarget" rather than guessing.
 */
export async function getRepoDefaultBranch(
  ref: RepoRef,
): Promise<string | null> {
  const key = `${ref.owner}/${ref.repo}`;
  const now = Date.now();
  const hit = defaultBranchCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const octokit = await getInstallationOctokit(ref.installationId);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: ref.owner,
      repo: ref.repo,
    });
    recordGithubMetric("repo.get", "ok", ref);
    const value = (res.data as { default_branch?: string }).default_branch;
    if (!value) return null;
    defaultBranchCache.set(key, {
      value,
      expiresAt: now + DEFAULT_BRANCH_TTL_MS,
    });
    return value;
  } catch (e) {
    recordGithubMetric("repo.get", "error", ref, statusOf(e));
    logger.warn({ err: e, ref }, "default-branch lookup failed");
    return null;
  }
}

export async function ensureLabel(
  ref: RepoRef,
  name: string,
  color = "ededed",
  description?: string,
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
          logger.debug({ err: createErr }, "label create race"),
        );
    } else {
      throw e;
    }
  }
}

export async function setLabels(
  ref: RepoRef,
  prNumber: number,
  labels: string[],
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  // Preserve any labels not managed by the bot. The bot only ever owns
  // `contribution:*` labels, so we drop those from the existing set and
  // re-apply the requested ones, leaving user/team labels untouched.
  const existing = await octokit
    .request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      per_page: 100,
    })
    .then((r) => r.data.map((l) => l.name))
    .catch(() => [] as string[]);
  const preserved = existing.filter((n) => !n.startsWith("contribution:"));
  const merged = Array.from(new Set([...preserved, ...labels]));
  await octokit.request(
    "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
    {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      labels: merged,
    },
  );
}

export async function addLabel(
  ref: RepoRef,
  prNumber: number,
  label: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      labels: [label],
    },
  );
}

export async function removeLabelIfPresent(
  ref: RepoRef,
  prNumber: number,
  label: string,
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
      },
    )
    .catch((e: unknown) => {
      if (statusOf(e) !== 404) throw e;
    });
}

export async function commentOnPr(
  ref: RepoRef,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(ref.installationId);
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      body,
    },
  );
}

/**
 * Whether any existing comment on the PR contains `needle` (e.g. the CLA
 * signing URL). Used to avoid posting a duplicate CLA reminder when one was
 * already posted out-of-band: a prior webhook re-evaluation, a manual
 * re-evaluation, or an earlier sweep. Best-effort: on API failure it returns
 * false so the caller falls back to its own (DB-state) dedup.
 */
export async function prHasCommentContaining(
  ref: RepoRef,
  prNumber: number,
  needle: string,
): Promise<boolean> {
  try {
    const octokit = await getInstallationOctokit(ref.installationId);
    // Single page (up to 100). The DB-state check is the primary dedup; this is
    // a secondary net, so one page is an acceptable bound on API cost.
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        per_page: 100,
      },
    );
    recordGithubMetric("list_comments", "ok", ref, res.status);
    const comments = res.data as Array<{ body?: string | null }>;
    return comments.some(
      (c) => typeof c.body === "string" && c.body.includes(needle),
    );
  } catch (e) {
    recordGithubMetric("list_comments", "error", ref, statusOf(e));
    logger.warn({ err: e, prNumber }, "prHasCommentContaining failed");
    return false;
  }
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
  existingId: string | null,
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
        },
      );
      recordGithubMetric("check_run.update", "ok", ref);
      Sentry.metrics.count("github.check_run", 1, {
        attributes: {
          "github.repo": `${ref.owner}/${ref.repo}`,
          "check.status": input.status,
          "check.conclusion": input.conclusion ?? "",
          mode: "update",
        },
      });
      return String((res.data as { id: number | string }).id);
    }
    const res = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: ref.owner,
      repo: ref.repo,
      ...body,
    });
    recordGithubMetric("check_run.create", "ok", ref);
    Sentry.metrics.count("github.check_run", 1, {
      attributes: {
        "github.repo": `${ref.owner}/${ref.repo}`,
        "check.status": input.status,
        "check.conclusion": input.conclusion ?? "",
        mode: "create",
      },
    });
    return String((res.data as { id: number | string }).id);
  } catch (e) {
    const status = statusOf(e);

    // A stored check-run id can go stale (the run was deleted, or it belongs to
    // a different repo/installation after a redeploy or DB migration). Updating
    // it then 404s. Recreate the run instead of silently dropping the check,
    // otherwise the check disappears from the PR permanently while a sibling
    // check with no stored id (e.g. a newly-added one) keeps showing.
    if (existingId && status === 404) {
      logger.warn(
        { ref, existingId, headSha: input.headSha },
        "check-run update 404 (stale id): recreating",
      );
      try {
        const res = await octokit.request(
          "POST /repos/{owner}/{repo}/check-runs",
          { owner: ref.owner, repo: ref.repo, ...body },
        );
        recordGithubMetric("check_run.create", "ok", ref);
        Sentry.metrics.count("github.check_run", 1, {
          attributes: {
            "github.repo": `${ref.owner}/${ref.repo}`,
            "check.status": input.status,
            "check.conclusion": input.conclusion ?? "",
            mode: "recreate",
          },
        });
        return String((res.data as { id: number | string }).id);
      } catch (e2) {
        const s2 = statusOf(e2);
        recordGithubMetric("check_run.create", "error", ref, s2);
        if (s2 === 403 || s2 === 404) {
          logger.warn(
            { err: e2, ref, headSha: input.headSha },
            "check-run recreate forbidden: installation likely missing checks:write",
          );
          return null;
        }
        throw e2;
      }
    }

    recordGithubMetric(
      existingId ? "check_run.update" : "check_run.create",
      "error",
      ref,
      status,
    );
    if (status === 403 || status === 404) {
      logger.warn(
        { err: e, ref, headSha: input.headSha },
        "check-run publish forbidden: installation likely missing checks:write",
      );
      return null;
    }
    throw e;
  }
}

const permsCache = new Map<
  number,
  { value: Record<string, string>; expiresAt: number }
>();
const PERMS_TTL_MS = 5 * 60 * 1000;

/**
 * The installation's permission map, cached 5 min. One probe backs every
 * permission feature-detect. A failed probe negative-caches an empty map, so
 * callers degrade to "not granted" rather than retrying in a hot loop.
 */
async function installationPermissions(
  installationId: number,
): Promise<Record<string, string>> {
  const now = Date.now();
  const hit = permsCache.get(installationId);
  if (hit && hit.expiresAt > now) return hit.value;
  const octokit = await getInstallationOctokit(installationId);
  try {
    const res = await octokit.request(
      "GET /app/installations/{installation_id}",
      {
        installation_id: installationId,
      },
    );
    const value =
      (res.data as { permissions?: Record<string, string> }).permissions ?? {};
    permsCache.set(installationId, { value, expiresAt: now + PERMS_TTL_MS });
    return value;
  } catch (e) {
    logger.warn({ err: e, installationId }, "installation-perms probe failed");
    permsCache.set(installationId, { value: {}, expiresAt: now + PERMS_TTL_MS });
    return {};
  }
}

/**
 * Feature-detect whether the installation grants `checks:write`. Used to avoid
 * 403s and to silently no-op when permission isn't granted (existing installs
 * that haven't accepted).
 */
export async function installationHasChecksWrite(
  installationId: number,
): Promise<boolean> {
  return (await installationPermissions(installationId)).checks === "write";
}

/**
 * Feature-detect whether the installation grants `contents:write`, which
 * staging routing needs only to create a missing staging branch. Existing
 * installations were set up with Contents: Read and must accept the upgrade,
 * so this is checked before attempting the write rather than after a 403.
 */
export async function installationHasContentsWrite(
  installationId: number,
): Promise<boolean> {
  return (await installationPermissions(installationId)).contents === "write";
}
