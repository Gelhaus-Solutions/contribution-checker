import { getInstallationOctokit } from "@/lib/github/app";
import { logger } from "@/lib/logger";
import { isBudgetError } from "@/lib/github/budget";
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
  prTemplate: string | null;
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

const templateCache = new Map<
  string,
  { template: string | null; expiresAt: number }
>();
const TEMPLATE_TTL_MS = 6 * 60 * 60 * 1000;

const TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
];

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

  // Account snapshot: cached
  const authorLogin = pr.user?.login ?? "";
  const account = authorLogin
    ? await getAccountSnapshot({
        octokit,
        login: authorLogin,
        wantForkCount: want?.has("account.mass_forking") ?? false,
        wantMergeRatio: want?.has("account.low_merge_ratio") ?? false,
      })
    : ({ login: "" } as AccountSnapshot);

  const prTemplate =
    want?.has("pr.uses_template") || want?.has("pr.template_extra_headers")
      ? await getPrTemplate({ octokit, owner, repo })
      : null;

  return {
    pr: {
      number: pr.number,
      title: pr.title ?? "",
      body: pr.body ?? null,
      headSha: pr.head?.sha ?? "",
      authorLogin,
    },
    prTemplate,
    files,
    filesTruncated,
    commits,
    account,
  };
}

async function getPrTemplate(args: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
}): Promise<string | null> {
  const key = `${args.owner.toLowerCase()}/${args.repo.toLowerCase()}`;
  const cached = templateCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.template;

  let template: string | null = null;
  for (const path of TEMPLATE_PATHS) {
    try {
      const res = await args.octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: args.owner, repo: args.repo, path }
      );
      const data = res.data as { content?: string; encoding?: string };
      if (data.content && data.encoding === "base64") {
        template = Buffer.from(data.content, "base64").toString("utf8");
        break;
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404) {
        logger.debug({ err: e, owner: args.owner, repo: args.repo, path }, "pr template fetch failed");
      }
    }
  }

  templateCache.set(key, { template, expiresAt: now + TEMPLATE_TTL_MS });
  return template;
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

  // One GraphQL round trip replaces the user lookup plus up to three search
  // calls, and GraphQL spends its own quota rather than the REST one the gate
  // runs on. Any failure (a bot login GraphQL cannot resolve, a schema hiccup)
  // falls through to the REST path below, which is what this always did.
  const viaGraphql = await getAccountSnapshotGraphql(args);
  if (viaGraphql) {
    accountCache.set(args.login.toLowerCase(), {
      snapshot: viaGraphql,
      expiresAt: now + ACCOUNT_TTL_MS,
    });
    return viaGraphql;
  }

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

const ACCOUNT_QUERY = `
  query Account(
    $login: String!
    $forkQuery: String!
    $prQuery: String!
    $mergedQuery: String!
    $wantFork: Boolean!
    $wantMerge: Boolean!
  ) {
    user(login: $login) {
      createdAt
      bio
      email
      avatarUrl
      followers { totalCount }
      repositories(privacy: PUBLIC) { totalCount }
    }
    forks: search(query: $forkQuery, type: REPOSITORY, first: 1) @include(if: $wantFork) {
      repositoryCount
    }
    prs: search(query: $prQuery, type: ISSUE, first: 1) @include(if: $wantMerge) {
      issueCount
    }
    merged: search(query: $mergedQuery, type: ISSUE, first: 1) @include(if: $wantMerge) {
      issueCount
    }
  }
`;

type AccountGraphql = {
  user: {
    createdAt?: string;
    bio?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
    followers?: { totalCount?: number };
    repositories?: { totalCount?: number };
  } | null;
  forks?: { repositoryCount?: number };
  prs?: { issueCount?: number };
  merged?: { issueCount?: number };
};

/**
 * The account snapshot in a single GraphQL query, or null when it cannot be
 * produced whole (the caller then uses REST). Never throws.
 */
async function getAccountSnapshotGraphql(args: {
  octokit: OctokitLike;
  login: string;
  wantForkCount: boolean;
  wantMergeRatio: boolean;
}): Promise<AccountSnapshot | null> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19);
    const data = (await args.octokit.graphql(ACCOUNT_QUERY, {
      login: args.login,
      forkQuery: `user:${args.login} fork:only created:>${since}`,
      prQuery: `is:pr author:${args.login}`,
      mergedQuery: `is:pr is:merged author:${args.login}`,
      wantFork: args.wantForkCount,
      wantMerge: args.wantMergeRatio,
    })) as AccountGraphql;
    const u = data.user;
    if (!u) return null;
    return {
      login: args.login,
      createdAt: u.createdAt,
      publicRepos: u.repositories?.totalCount,
      followers: u.followers?.totalCount,
      // GraphQL answers "" where REST answers null for an unset field.
      bio: u.bio || null,
      email: u.email || null,
      hasAvatar: Boolean(u.avatarUrl),
      ...(args.wantForkCount
        ? { recentForkCount: data.forks?.repositoryCount }
        : {}),
      ...(args.wantMergeRatio
        ? {
            totalPrCount: data.prs?.issueCount,
            mergedPrCount: data.merged?.issueCount,
          }
        : {}),
    };
  } catch (e) {
    // A refused request says nothing about the account. Propagate it rather
    // than caching an empty snapshot for a day.
    if (isBudgetError(e)) throw e;
    logger.debug({ err: e, login: args.login }, "account graphql failed");
    return null;
  }
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
