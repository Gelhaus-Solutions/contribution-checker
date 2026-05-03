import { getInstallationOctokit } from "@/lib/github/app";
import { logger } from "@/lib/logger";
import type {
  AccountSnapshot,
  PrCommit,
  PrFile,
} from "@/lib/quality/types";

const FILE_PAGE_SIZE = 100;
const FILE_PAGE_LIMIT = 3; // 300 files max
const COMMIT_PAGE_SIZE = 100;
const COMMIT_PAGE_LIMIT = 3; // 300 commits max

export type FetchedPrContext = {
  pr: {
    number: number;
    title: string;
    body: string | null;
    headSha: string;
    authorLogin: string;
  };
  files: PrFile[];
  filesTruncated: boolean;
  commits: PrCommit[];
  account: AccountSnapshot;
};

const accountCache = new Map<
  string,
  { snapshot: AccountSnapshot; expiresAt: number }
>();
const ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch everything quality heuristics need from GitHub: PR object, files,
 * commits, account snapshot. Cached at the account level (24h TTL); the PR
 * data is always re-fetched since it changes on push.
 *
 * Optional `enabledHeuristicIds` lets us skip expensive search-API calls
 * when the relevant heuristics are disabled.
 */
export async function fetchPrContext(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  enabledHeuristicIds?: Set<string>;
}): Promise<FetchedPrContext | null> {
  const octokit = await getInstallationOctokit(args.installationId);
  const { owner, repo, prNumber } = args;
  const want = args.enabledHeuristicIds;

  // Core PR object
  const pr = await octokit
    .request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
    })
    .then((r) => r.data as PrPayload)
    .catch((e: unknown) => {
      logger.warn({ err: e, owner, repo, prNumber }, "fetch pr failed");
      return null;
    });
  if (!pr) return null;

  // Paged files
  const files: PrFile[] = [];
  let filesTruncated = false;
  for (let page = 1; page <= FILE_PAGE_LIMIT; page++) {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner,
        repo,
        pull_number: prNumber,
        per_page: FILE_PAGE_SIZE,
        page,
      }
    );
    const batch = res.data as RawFile[];
    for (const f of batch) {
      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changes: f.changes ?? 0,
        patch: f.patch ?? null,
        previous_filename: f.previous_filename,
      });
    }
    if (batch.length < FILE_PAGE_SIZE) break;
    if (page === FILE_PAGE_LIMIT) filesTruncated = true;
  }

  // Paged commits
  const commits: PrCommit[] = [];
  for (let page = 1; page <= COMMIT_PAGE_LIMIT; page++) {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
      {
        owner,
        repo,
        pull_number: prNumber,
        per_page: COMMIT_PAGE_SIZE,
        page,
      }
    );
    const batch = res.data as RawCommit[];
    for (const c of batch) {
      commits.push({
        sha: c.sha,
        message: c.commit?.message ?? "",
        authorLogin: c.author?.login,
        authorEmail: c.commit?.author?.email,
        committerEmail: c.commit?.committer?.email,
      });
    }
    if (batch.length < COMMIT_PAGE_SIZE) break;
  }

  // Account snapshot — cached
  const authorLogin = pr.user?.login ?? "";
  const account = authorLogin
    ? await getAccountSnapshot({
        octokit,
        login: authorLogin,
        wantForkCount: want?.has("account.mass_forking") ?? false,
        wantMergeRatio: want?.has("account.low_merge_ratio") ?? false,
      })
    : ({ login: "" } as AccountSnapshot);

  return {
    pr: {
      number: pr.number,
      title: pr.title ?? "",
      body: pr.body ?? null,
      headSha: pr.head?.sha ?? "",
      authorLogin,
    },
    files,
    filesTruncated,
    commits,
    account,
  };
}

type OctokitLike = Awaited<ReturnType<typeof getInstallationOctokit>>;

async function getAccountSnapshot(args: {
  octokit: OctokitLike;
  login: string;
  wantForkCount: boolean;
  wantMergeRatio: boolean;
}): Promise<AccountSnapshot> {
  const cached = accountCache.get(args.login.toLowerCase());
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.snapshot;

  const snapshot: AccountSnapshot = { login: args.login };
  try {
    const res = await args.octokit.request("GET /users/{username}", {
      username: args.login,
    });
    const u = res.data as RawUser;
    snapshot.createdAt = u.created_at;
    snapshot.publicRepos = u.public_repos;
    snapshot.followers = u.followers;
    snapshot.bio = u.bio;
    snapshot.email = u.email;
    snapshot.hasAvatar = Boolean(u.avatar_url);
  } catch (e) {
    logger.debug({ err: e, login: args.login }, "user fetch failed");
  }

  if (args.wantForkCount) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      const res = await args.octokit.request("GET /search/repositories", {
        q: `user:${args.login} fork:only created:>${since}`,
        per_page: 1,
      });
      snapshot.recentForkCount = (res.data as { total_count?: number }).total_count;
    } catch (e) {
      logger.debug({ err: e, login: args.login }, "fork search failed");
    }
  }

  if (args.wantMergeRatio) {
    try {
      const [total, merged] = await Promise.all([
        args.octokit.request("GET /search/issues", {
          q: `is:pr author:${args.login}`,
          per_page: 1,
        }),
        args.octokit.request("GET /search/issues", {
          q: `is:pr is:merged author:${args.login}`,
          per_page: 1,
        }),
      ]);
      snapshot.totalPrCount = (total.data as { total_count?: number }).total_count;
      snapshot.mergedPrCount = (merged.data as { total_count?: number })
        .total_count;
    } catch (e) {
      logger.debug({ err: e, login: args.login }, "pr-search failed");
    }
  }

  accountCache.set(args.login.toLowerCase(), {
    snapshot,
    expiresAt: now + ACCOUNT_TTL_MS,
  });
  return snapshot;
}

// ----- Octokit response shape (subset) -----

type PrPayload = {
  number: number;
  title?: string;
  body?: string | null;
  user?: { login?: string };
  head?: { sha?: string };
};

type RawFile = {
  filename: string;
  status: PrFile["status"];
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  previous_filename?: string;
};

type RawCommit = {
  sha: string;
  author?: { login?: string };
  commit?: {
    message?: string;
    author?: { email?: string };
    committer?: { email?: string };
  };
};

type RawUser = {
  created_at?: string;
  public_repos?: number;
  followers?: number;
  bio?: string | null;
  email?: string | null;
  avatar_url?: string;
};
