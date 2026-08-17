import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { matchesAnyPattern } from "@/lib/applications/decide-pr";
import {
  addLabel,
  compareBranches,
  createBranch,
  createPullRequest,
  ensureLabel,
  fastForwardBranch,
  getBranchSha,
  mergeBranch,
  getPullRequest,
  getRepoDefaultBranch,
  installationHasContentsWrite,
  listPullRequests,
  repoRef,
  setPullRequestBase,
  updatePullRequestBody,
  type PrSummary,
  type RepoRef,
} from "@/lib/github/pr-actions";

/**
 * Staging branch routing. Two cooperating halves, toggled independently on the
 * project:
 *
 *  - `applyStagingRouting` rewrites a PR based on the repo's default branch to
 *    target the project's staging branch instead. It runs independently of the
 *    contributor gate: a PENDING PR is retargeted before it is closed, so a
 *    later approval reopens it already pointing at staging.
 *  - `reconcileStagingBatch` keeps one bot-owned aggregate PR open from staging
 *    to the default branch, whose description lists the batch. It is a full
 *    re-derivation from live GitHub state, so it is safe to run at any time and
 *    any number of times.
 *
 * Everything here is best-effort and idempotent. GitHub failures are logged and
 * swallowed at the entrypoints so a staging problem can never block the gate.
 */

/** Markers delimiting the block the bot owns inside the aggregate PR body.
 * Anything outside them is a human's and is preserved verbatim. */
const BLOCK_START = "<!-- staging-batch:start -->";
const BLOCK_END = "<!-- staging-batch:end -->";

const AGGREGATE_PR_TITLE = "Ship staging to production";

/** The project fields both halves need. */
export type StagingProject = {
  id: string;
  bypassHandles: string;
  stagingRetargetEnabled: boolean;
  stagingBatchPrEnabled: boolean;
  stagingSyncEnabled: boolean;
  stagingBranch: string;
  labelStagingBatch: string;
  labelStagingOptOut: string;
};

/** The per-repo overrides. Null on any field means "inherit the project". */
export type StagingRepoOverrides = {
  stagingRetargetEnabled: boolean | null;
  stagingBatchPrEnabled: boolean | null;
  stagingSyncEnabled: boolean | null;
  stagingBranch: string | null;
};

export const stagingProjectSelect = {
  id: true,
  bypassHandles: true,
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: true,
  stagingBranch: true,
  labelStagingBatch: true,
  labelStagingOptOut: true,
} as const;

export const stagingRepoSelect = {
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: true,
  stagingBranch: true,
} as const;

/** The settings actually in force for one repo, after overrides. */
export type ResolvedStagingConfig = {
  retargetEnabled: boolean;
  batchPrEnabled: boolean;
  /** Keep staging current with the default branch, with no PR. */
  syncEnabled: boolean;
  stagingBranch: string;
  /** Staging routing does anything at all for this repo. `syncEnabled` alone
   * does not qualify: syncing a branch nothing routes through is a write to
   * someone's repo for no reason. */
  anyEnabled: boolean;
  /** Which fields the repo overrode, for the settings UI to show. */
  overridden: {
    retargetEnabled: boolean;
    batchPrEnabled: boolean;
    syncEnabled: boolean;
    stagingBranch: boolean;
  };
};

/**
 * Fold the per-repo overrides onto the project defaults. The single place that
 * decides what staging routing does for a given repo: read this, never the
 * columns, so a repo override cannot be honored on one code path and ignored
 * on another.
 */
export function resolveStagingConfig(
  project: Pick<
    StagingProject,
    | "stagingRetargetEnabled"
    | "stagingBatchPrEnabled"
    | "stagingSyncEnabled"
    | "stagingBranch"
  >,
  repo: StagingRepoOverrides | null,
): ResolvedStagingConfig {
  const branch = repo?.stagingBranch?.trim();
  const retargetEnabled =
    repo?.stagingRetargetEnabled ?? project.stagingRetargetEnabled;
  const batchPrEnabled =
    repo?.stagingBatchPrEnabled ?? project.stagingBatchPrEnabled;
  const anyEnabled = retargetEnabled || batchPrEnabled;
  return {
    retargetEnabled,
    batchPrEnabled,
    syncEnabled:
      anyEnabled && (repo?.stagingSyncEnabled ?? project.stagingSyncEnabled),
    stagingBranch: branch || project.stagingBranch,
    anyEnabled,
    overridden: {
      retargetEnabled: repo?.stagingRetargetEnabled != null,
      batchPrEnabled: repo?.stagingBatchPrEnabled != null,
      syncEnabled: repo?.stagingSyncEnabled != null,
      stagingBranch: !!branch,
    },
  };
}

function parseBypassHandles(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is string => typeof h === "string");
  } catch {
    return [];
  }
}

// --- pure helpers (unit-tested without Octokit) ------------------------------

/** One PR in the batch, as the manifest renders it. */
export type BatchEntry = {
  number: number;
  author: string | null;
};

/**
 * Render the manifest block. Kept pure and exported so the formatting is
 * testable on its own, the same way `buildDecisionCheckPayload` is split from
 * `publishDecisionCheck`.
 */
export function renderBatchBlock(entries: BatchEntry[]): string {
  const lines =
    entries.length === 0
      ? ["_No merged PRs in this batch yet._"]
      : entries.map((e) => {
          // No title: GitHub expands the `#123` reference into the PR's title
          // when it renders, so carrying our own copy only duplicated it.
          const by = e.author ? ` by @${e.author}` : "";
          return `- #${e.number}${by}`;
        });
  return [BLOCK_START, "### In this batch", "", ...lines, BLOCK_END].join("\n");
}

/**
 * Splice `block` into `body`, replacing whatever is between the markers and
 * leaving every other character alone. When the body has no markers the block
 * is appended, so a human can write a preamble and keep it.
 */
export function applyBatchBlock(body: string | null, block: string): string {
  const current = body ?? "";
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return current.trim().length === 0
      ? block
      : `${current.trimEnd()}\n\n${block}`;
  }
  const before = current.slice(0, start);
  const after = current.slice(end + BLOCK_END.length);
  return `${before}${block}${after}`;
}

/** Identity of a PR's head, which for a fork lives in a different repo. */
export type PrHead = {
  ref: string;
  /** Head repo full name; null when the fork was deleted. */
  repoFullName: string | null;
};

/**
 * Is this the aggregate staging PR? Matched structurally as well as by the
 * tracked number, so the window between opening it and persisting the number
 * is covered, and so a maintainer's hand-opened staging -> default PR is
 * recognized as the same thing.
 *
 * The head repo check matters: a fork whose branch happens to be called
 * `staging` is an ordinary contribution, not the aggregate PR.
 */
export function isAggregatePr(args: {
  prNumber: number;
  trackedPrNumber: number | null;
  head: PrHead;
  baseRef: string;
  baseRepoFullName: string;
  stagingBranch: string;
  defaultBranch: string;
}): boolean {
  if (args.trackedPrNumber != null && args.prNumber === args.trackedPrNumber) {
    return true;
  }
  return (
    args.head.repoFullName === args.baseRepoFullName &&
    args.head.ref === args.stagingBranch &&
    args.baseRef === args.defaultBranch
  );
}

/**
 * Should this PR be retargeted to staging? Pure so every exemption is testable
 * without a database or GitHub. Returns the reason to skip, or null to proceed.
 */
export type StagingRetargetSkipReason =
  | "staging_is_default"
  | "aggregate_pr"
  | "head_is_staging"
  | "opt_out_label"
  | "bypass_handle"
  | "base_not_default";

export function stagingRetargetSkipReason(args: {
  baseRef: string;
  head: PrHead;
  baseRepoFullName: string;
  defaultBranch: string;
  stagingBranch: string;
  prNumber: number;
  aggregatePrNumber: number | null;
  prLabels: string[];
  optOutLabel: string;
  authorGhLogin: string;
  bypassHandles: string[];
}): StagingRetargetSkipReason | null {
  if (args.stagingBranch === args.defaultBranch) return "staging_is_default";
  // The bot's own aggregate PR: retargeting it would make it staging -> staging.
  if (
    isAggregatePr({
      prNumber: args.prNumber,
      trackedPrNumber: args.aggregatePrNumber,
      head: args.head,
      baseRef: args.baseRef,
      baseRepoFullName: args.baseRepoFullName,
      stagingBranch: args.stagingBranch,
      defaultBranch: args.defaultBranch,
    })
  ) {
    return "aggregate_pr";
  }
  // A same-repo branch already called staging has nowhere to go. A FORK branch
  // of the same name is an ordinary contribution and must still be retargeted.
  if (
    args.head.repoFullName === args.baseRepoFullName &&
    args.head.ref === args.stagingBranch
  ) {
    return "head_is_staging";
  }
  if (args.prLabels.includes(args.optOutLabel)) return "opt_out_label";
  if (matchesAnyPattern(args.authorGhLogin, args.bypassHandles)) {
    return "bypass_handle";
  }
  // Already where we want it. This is also what makes the feature loop-safe:
  // our own PATCH emits a `pull_request.edited` redelivery, which lands here
  // with the base already staging and stops.
  if (args.baseRef !== args.defaultBranch) return "base_not_default";
  return null;
}

/**
 * Ping-pong fuse. "Rewrite the base back unless opt-out-labeled" is, against a
 * determined human or a competing automation that enforces base == default, an
 * unbounded two-cycle. Our own echo is already stopped structurally (the base
 * is staging by then), so anything that trips this is a real fight, and losing
 * it quietly beats hammering the API forever.
 *
 * Per-process and best-effort, like the other TTL maps in this codebase: a
 * mitigation, not a guarantee across replicas.
 */
const retargetFuse = new Map<string, { count: number; expiresAt: number }>();
const FUSE_WINDOW_MS = 60 * 60 * 1000;
const FUSE_MAX = 3;

function fuseTripped(key: string): boolean {
  const now = Date.now();
  const hit = retargetFuse.get(key);
  if (!hit || hit.expiresAt <= now) {
    retargetFuse.set(key, { count: 1, expiresAt: now + FUSE_WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > FUSE_MAX;
}

/**
 * Did this merge commit bring anything the default branch does not already
 * have? A merge commit is unique to staging even when everything it merged is
 * already on the default branch by another route, so "the merge commit is in
 * `default...staging`" is not enough on its own.
 *
 * The named case: a maintainer merges branch X into staging, then opens a
 * second PR from the same X against the default branch and merges that too.
 * The staging merge commit is still only on staging, but its content shipped
 * without it, so listing it claims the batch ships something it does not.
 *
 * The head-side parents of a merge are what it brought in. If none of them is
 * in the batch, they are all already on the default branch. A single-parent
 * merge commit is a squash or rebase merge, whose commit *is* the content, so
 * it always counts.
 */
function mergeAlreadyOnDefault(args: {
  mergeCommitSha: string;
  batchShas: Set<string>;
  batchParents: Record<string, string[]> | null;
}): boolean {
  const parents = args.batchParents?.[args.mergeCommitSha];
  if (!parents || parents.length < 2) return false;
  return !parents.slice(1).some((p) => args.batchShas.has(p));
}

/**
 * Which PRs belong in the current batch: those merged into staging whose merge
 * commit is part of what staging will actually ship.
 *
 * Membership is decided by reachability (`batchShas`, the commits in
 * `default...staging`), not by timestamp. A timestamp cutoff cannot answer this
 * question: syncing the default branch into staging makes the merge base the
 * default branch's tip, a commit created moments ago, so a `mergedAt > cutoff`
 * filter silently drops every PR merged into staging before the last sync,
 * which is nearly all of them. `since` survives only as the fallback for a
 * truncated compare (>250 commits) or a PR with no recorded merge commit.
 *
 * Open PRs are deliberately excluded. The manifest is a record of what this
 * batch will ship, and an open PR is a proposal: it may never merge, may merge
 * into a later batch, or may be closed. Listing it would make the aggregate
 * PR's description a claim about code that is not in it.
 *
 * Closed-without-merging PRs are excluded for the same reason.
 */
export function selectBatchEntries(args: {
  prs: PrSummary[];
  stagingBranch: string;
  since: Date | null;
  /** Commits in `default...staging`, or null when membership is unknowable. */
  batchShas: Set<string> | null;
  /** sha -> parents, for the same commit range. */
  batchParents: Record<string, string[]> | null;
  excludePrNumber: number | null;
}): BatchEntry[] {
  const kept = args.prs.filter((pr) => {
    if (pr.number === args.excludePrNumber) return false;
    if (pr.baseRef !== args.stagingBranch) return false;
    if (!pr.merged) return false; // open, or closed without merging
    if (args.batchShas && pr.mergeCommitSha) {
      if (!args.batchShas.has(pr.mergeCommitSha)) return false;
      return !mergeAlreadyOnDefault({
        mergeCommitSha: pr.mergeCommitSha,
        batchShas: args.batchShas,
        batchParents: args.batchParents,
      });
    }
    if (!args.since) return true;
    return pr.mergedAt != null && new Date(pr.mergedAt) > args.since;
  });
  // Ascending PR number reads as chronological and keeps the body stable
  // across reconciles (the list endpoint sorts by updated-at, which churns).
  kept.sort((a, b) => a.number - b.number);
  return kept.map((pr) => ({
    number: pr.number,
    author: pr.authorLogin,
  }));
}

// --- default branch resolution -----------------------------------------------

/**
 * Resolve the repo's default branch, cheapest source first: the webhook payload
 * hint, then the `Repo.defaultBranch` cache, then a TTL-cached API call. A
 * fresh answer is written back to the cache column. Returns null when nothing
 * could answer, which callers must treat as "do not retarget".
 */
async function resolveDefaultBranch(args: {
  repoId: string;
  ref: RepoRef;
  hint: string | null;
  cached: string | null;
}): Promise<string | null> {
  if (args.hint) {
    if (args.hint !== args.cached) {
      await prisma.repo
        .update({
          where: { id: args.repoId },
          data: { defaultBranch: args.hint },
        })
        .catch((e) =>
          logger.warn({ err: e, repoId: args.repoId }, "default-branch cache write failed"),
        );
    }
    return args.hint;
  }
  if (args.cached) return args.cached;
  const fetched = await getRepoDefaultBranch(args.ref);
  if (fetched) {
    await prisma.repo
      .update({ where: { id: args.repoId }, data: { defaultBranch: fetched } })
      .catch((e) =>
        logger.warn({ err: e, repoId: args.repoId }, "default-branch cache write failed"),
      );
  }
  return fetched;
}

/**
 * Make sure the staging branch exists, creating it at the default branch head
 * if not. Returns false when it is missing and could not be created, which
 * happens when the installation has not granted `contents:write`.
 */
async function ensureStagingBranch(args: {
  ref: RepoRef;
  stagingBranch: string;
  defaultBranch: string;
}): Promise<boolean> {
  const existing = await getBranchSha(args.ref, args.stagingBranch);
  if (existing) return true;
  // Feature-detect before writing: installations created before this feature
  // hold Contents: Read, and probing once every 5 minutes beats a 403 on every
  // single event until the owner accepts the upgrade.
  if (!(await installationHasContentsWrite(args.ref.installationId))) {
    logger.warn(
      { ref: args.ref, stagingBranch: args.stagingBranch },
      "staging branch create skipped: installation missing contents:write",
    );
    return false;
  }
  const base = await getBranchSha(args.ref, args.defaultBranch);
  if (!base) {
    logger.warn(
      { ref: args.ref, defaultBranch: args.defaultBranch },
      "staging branch create skipped: default branch head not found",
    );
    return false;
  }
  const created = await createBranch(args.ref, args.stagingBranch, base);
  if (created) {
    logger.info(
      { ref: args.ref, stagingBranch: args.stagingBranch },
      "created staging branch from default branch head",
    );
  }
  return created;
}

// --- half one: retargeting ---------------------------------------------------

/**
 * Every way routing can end. Carried on the result rather than only logged,
 * because the result becomes the Temporal activity result and is therefore
 * readable from workflow history when the logs are unavailable. "Why did this
 * PR not get retargeted?" is the question that gets asked after the fact, and
 * a `retargeted: false` boolean cannot answer it.
 */
export type StagingRoutingOutcome =
  | "retargeted"
  | "not_managed"
  | "pr_closed"
  | "default_branch_unknown"
  | "retarget_disabled"
  | "staging_branch_unavailable"
  | "fuse_tripped"
  | "already_in_staging"
  | "error"
  | StagingRetargetSkipReason;

/** What the caller in webhook.ts needs to know after routing ran. */
export type StagingRoutingResult = {
  /** Local Repo.id, or null when the repo is not managed here. */
  repoId: string | null;
  /** The base was actually changed, so a reconcile is worth signalling. */
  retargeted: boolean;
  /** This PR is the bot's own aggregate PR: it must skip the gate entirely. */
  isAggregatePr: boolean;
  /** The PR sits on the staging branch, so the batch manifest may be stale. */
  touchesStaging: boolean;
  /** Why routing ended the way it did. Surfaced into Temporal history. */
  outcome: StagingRoutingOutcome;
};

const NO_ROUTING: StagingRoutingResult = {
  repoId: null,
  retargeted: false,
  isAggregatePr: false,
  touchesStaging: false,
  outcome: "not_managed",
};

/**
 * Rewrite a PR based on the default branch to target the project's staging
 * branch. Runs before, and independently of, the contributor gate. Never
 * throws: a staging failure must not stop the PR from being gated.
 */
export async function applyStagingRouting(ctx: {
  ghRepoId: number;
  prNumber: number;
  authorGhLogin: string;
  baseRef: string;
  head: PrHead;
  prLabels: string[];
  defaultBranchHint: string | null;
  prIsClosed: boolean;
}): Promise<StagingRoutingResult> {
  try {
    if (ctx.prIsClosed) return { ...NO_ROUTING, outcome: "pr_closed" };
    const repo = await prisma.repo.findUnique({
      where: { ghRepoId: ctx.ghRepoId },
      select: {
        id: true,
        fullName: true,
        installationId: true,
        active: true,
        defaultBranch: true,
        stagingBatchPrNumber: true,
        ...stagingRepoSelect,
        project: { select: stagingProjectSelect },
      },
    });
    if (!repo || !repo.active || repo.installationId == null) return NO_ROUTING;
    const project = repo.project;
    const cfg = resolveStagingConfig(project, repo);

    const ref = repoRef(repo.fullName, repo.installationId);
    const defaultBranch = await resolveDefaultBranch({
      repoId: repo.id,
      ref,
      hint: ctx.defaultBranchHint,
      cached: repo.defaultBranch,
    });
    if (!defaultBranch) {
      logger.warn(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
        "staging routing skipped: default branch unknown",
      );
      return { ...NO_ROUTING, outcome: "default_branch_unknown" };
    }

    // Recognized before the enable check: the aggregate PR must be exempt from
    // the contributor gate whatever the staging toggles say, or the bot closes
    // its own release PR as an unapproved contribution.
    const isAggregate = isAggregatePr({
      prNumber: ctx.prNumber,
      trackedPrNumber: repo.stagingBatchPrNumber,
      head: ctx.head,
      baseRef: ctx.baseRef,
      baseRepoFullName: repo.fullName,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
    });
    const base = {
      repoId: repo.id,
      isAggregatePr: isAggregate && cfg.batchPrEnabled,
      touchesStaging: ctx.baseRef === cfg.stagingBranch,
    };
    if (!cfg.retargetEnabled) {
      return { ...base, retargeted: false, outcome: "retarget_disabled" };
    }

    const skip = stagingRetargetSkipReason({
      baseRef: ctx.baseRef,
      head: ctx.head,
      baseRepoFullName: repo.fullName,
      defaultBranch,
      stagingBranch: cfg.stagingBranch,
      prNumber: ctx.prNumber,
      aggregatePrNumber: repo.stagingBatchPrNumber,
      prLabels: ctx.prLabels,
      optOutLabel: project.labelStagingOptOut,
      authorGhLogin: ctx.authorGhLogin,
      bypassHandles: parseBypassHandles(project.bypassHandles),
    });
    if (skip) {
      // Info, not debug: this is the line that answers "why is this PR still
      // on the default branch?", and it is worthless if it only exists at a
      // level nobody runs in production.
      logger.info(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber, skip },
        "staging retarget skipped",
      );
      return { ...base, retargeted: false, outcome: skip };
    }

    if (fuseTripped(`${ctx.ghRepoId}#${ctx.prNumber}`)) {
      logger.warn(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
        `staging retarget fuse tripped: the base has been moved back to the ` +
          `default branch repeatedly. Add the staging opt-out label to settle ` +
          `it, or check for another automation enforcing the base.`,
      );
      return { ...base, retargeted: false, outcome: "fuse_tripped" };
    }

    const ready = await ensureStagingBranch({
      ref,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
    });
    if (!ready) {
      return { ...base, retargeted: false, outcome: "staging_branch_unavailable" };
    }

    try {
      await setPullRequestBase(ref, ctx.prNumber, cfg.stagingBranch);
    } catch (e) {
      // The head branch is already fully contained in staging, usually because
      // an earlier PR from the same branch was merged there. GitHub refuses a
      // base change that would leave the PR with an empty diff, so this PR can
      // never be retargeted. It is still pointed at the default branch, and
      // merging it lands those commits there a second time, outside the batch.
      // Nothing here can prevent that, so the least we owe the operator is a
      // named outcome instead of a stack trace.
      if (isNoNewCommitsError(e)) {
        logger.warn(
          {
            ghRepoId: ctx.ghRepoId,
            prNumber: ctx.prNumber,
            stagingBranch: cfg.stagingBranch,
            headRef: ctx.head.ref,
          },
          `staging retarget impossible: the head branch is already merged into ` +
            `staging, so this PR has no diff against it. It remains based on ` +
            `the default branch and will bypass the batch if merged.`,
        );
        return { ...base, retargeted: false, outcome: "already_in_staging" };
      }
      throw e;
    }
    logger.info(
      {
        ghRepoId: ctx.ghRepoId,
        prNumber: ctx.prNumber,
        from: defaultBranch,
        to: cfg.stagingBranch,
      },
      "retargeted PR to staging",
    );
    return {
      ...base,
      retargeted: true,
      touchesStaging: true,
      outcome: "retargeted",
    };
  } catch (e) {
    logger.warn(
      { err: e, ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
      "applyStagingRouting failed",
    );
    return { ...NO_ROUTING, outcome: "error" };
  }
}

/**
 * GitHub's 422 for "you cannot point this PR there, the diff would be empty".
 * Matched on the message because the error body carries no distinct code:
 * `field: "base", code: "invalid"` is shared with several other rejections.
 */
function isNoNewCommitsError(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status !== 422) return false;
  const message = (e as { message?: string } | null)?.message ?? "";
  return /no new commits between/i.test(message);
}

// --- half three: keeping staging current with the default branch -------------

/** What a sync attempt did, for logging and for the caller's next decision. */
export type StagingSyncResult =
  | "up_to_date"
  | "fast_forwarded"
  | "merged"
  | "conflict"
  | "forbidden"
  | "failed";

/**
 * Bring the staging branch up to date with the default branch, with no PR.
 *
 * Without this, staging only ever moves when something merges into it, so a
 * default branch that keeps advancing leaves staging stale and every
 * contributor retargeted onto it is working from an old base. The named case
 * is the simplest one: nothing has merged into staging yet, the default branch
 * moved, and staging should just follow it.
 *
 * Two strategies, picked by what staging actually contains:
 *  - staging has no commits of its own: fast-forward the ref. No merge commit,
 *    no conflict possible, and the branches end up identical.
 *  - staging has unmerged work: server-side merge, which creates a merge commit
 *    and never rewrites history, so the batch keeps its commits and its
 *    aggregate PR keeps showing an honest diff.
 *
 * Never throws. A conflict is a real state a human has to resolve, not an
 * error to retry, so it is logged and reported rather than raised.
 */
async function syncStagingWithDefault(args: {
  ref: RepoRef;
  repoId: string;
  stagingBranch: string;
  defaultBranch: string;
  aheadBy: number;
}): Promise<StagingSyncResult> {
  try {
    if (!(await installationHasContentsWrite(args.ref.installationId))) {
      logger.warn(
        { ref: args.ref, stagingBranch: args.stagingBranch },
        "staging sync skipped: installation missing contents:write",
      );
      return "forbidden";
    }

    // Fast-forward path: staging is a strict ancestor of the default branch,
    // so moving the ref cannot lose anything. GitHub rejects a non-fast-forward
    // update (we never pass force), which is the safety net if `aheadBy` is
    // stale by the time we get here.
    if (args.aheadBy === 0) {
      const sha = await getBranchSha(args.ref, args.defaultBranch);
      if (!sha) return "failed";
      if (await fastForwardBranch(args.ref, args.stagingBranch, sha)) {
        logger.info(
          {
            repoId: args.repoId,
            from: args.defaultBranch,
            to: args.stagingBranch,
          },
          "fast-forwarded staging to the default branch",
        );
        return "fast_forwarded";
      }
      // Raced with a push to staging: fall through and merge instead.
    }

    const res = await mergeBranch(
      args.ref,
      args.stagingBranch,
      args.defaultBranch,
      `Merge ${args.defaultBranch} into ${args.stagingBranch}`,
    );
    if ("failure" in res) {
      if (res.failure === "conflict") {
        logger.warn(
          {
            repoId: args.repoId,
            stagingBranch: args.stagingBranch,
            defaultBranch: args.defaultBranch,
          },
          "staging sync hit a merge conflict; resolve it on the staging branch",
        );
      }
      return res.failure === "conflict" ? "conflict" : "failed";
    }
    if (res.merged) {
      logger.info(
        {
          repoId: args.repoId,
          from: args.defaultBranch,
          to: args.stagingBranch,
        },
        "merged the default branch into staging",
      );
      return "merged";
    }
    return "up_to_date";
  } catch (e) {
    logger.warn(
      { err: e, repoId: args.repoId },
      "syncStagingWithDefault failed",
    );
    return "failed";
  }
}

// --- half two: the aggregate PR ----------------------------------------------

/**
 * Locate the open aggregate PR, in the order the design calls for: the tracked
 * number, then a label search among open staging -> default PRs, then null
 * (the caller creates one). A tracked number that no longer describes an open
 * staging -> default PR is discarded rather than trusted.
 */
async function findAggregatePr(args: {
  ref: RepoRef;
  repoId: string;
  tracked: number | null;
  stagingBranch: string;
  defaultBranch: string;
  batchLabel: string;
}): Promise<PrSummary | null> {
  if (args.tracked != null) {
    const pr = await getPullRequest(args.ref, args.tracked);
    if (
      pr &&
      pr.state === "open" &&
      pr.headRef === args.stagingBranch &&
      pr.baseRef === args.defaultBranch
    ) {
      return pr;
    }
  }
  const open = await listPullRequests(args.ref, {
    state: "open",
    base: args.defaultBranch,
    head: `${args.ref.owner}:${args.stagingBranch}`,
  });
  const labeled = open.find((pr) => pr.labels.includes(args.batchLabel));
  return labeled ?? open[0] ?? null;
}

async function trackAggregatePr(repoId: string, prNumber: number | null) {
  await prisma.repo
    .update({ where: { id: repoId }, data: { stagingBatchPrNumber: prNumber } })
    .catch((e) =>
      logger.warn({ err: e, repoId }, "aggregate PR tracking write failed"),
    );
}

/** What one reconcile pass did, so the entity can pace the next one. */
export type StagingReconcileResult = {
  /** Staging was moved onto the default branch this pass. */
  synced: boolean;
  /** A sync is wanted but the batching window has not elapsed yet. */
  syncDeferred: boolean;
};

const NOTHING_DONE: StagingReconcileResult = {
  synced: false,
  syncDeferred: false,
};

/**
 * Re-derive a repo's aggregate staging PR from live GitHub state: ensure it
 * exists while staging is ahead, and keep its manifest block accurate. Called
 * only from the per-repo `stagingBatch` entity workflow, so runs for one repo
 * never overlap. Never throws.
 */
export async function reconcileStagingBatch(args: {
  repoId: string;
  /** False while the sync batching window is still open: the reconcile then
   * refreshes the manifest as usual but reports the sync as deferred instead
   * of writing to the branch. */
  allowSync: boolean;
}): Promise<StagingReconcileResult> {
  try {
    const repo = await prisma.repo.findUnique({
      where: { id: args.repoId },
      select: {
        id: true,
        fullName: true,
        installationId: true,
        active: true,
        defaultBranch: true,
        stagingBatchPrNumber: true,
        stagingBatchSince: true,
        ...stagingRepoSelect,
        project: { select: stagingProjectSelect },
      },
    });
    if (!repo || !repo.active || repo.installationId == null) return NOTHING_DONE;
    const project = repo.project;
    const cfg = resolveStagingConfig(project, repo);
    // Keeping staging current is useful even for a repo that only retargets,
    // so the guard is "staging routing does anything here", not "the aggregate
    // PR is on". The two halves are gated individually below.
    if (!cfg.anyEnabled) return NOTHING_DONE;

    const ref = repoRef(repo.fullName, repo.installationId);
    const defaultBranch = await resolveDefaultBranch({
      repoId: repo.id,
      ref,
      hint: null,
      cached: repo.defaultBranch,
    });
    if (!defaultBranch) return NOTHING_DONE;
    if (defaultBranch === cfg.stagingBranch) {
      logger.warn(
        { repoId: repo.id, branch: defaultBranch },
        "staging batch skipped: staging branch is the default branch",
      );
      return NOTHING_DONE;
    }

    const ready = await ensureStagingBranch({
      ref,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
    });
    if (!ready) return NOTHING_DONE;

    const cmp = await compareBranches(ref, defaultBranch, cfg.stagingBranch);

    // Bring staging up to date with the default branch first, so the batch is
    // measured and shipped against current code. Syncing writes commits, so it
    // is rate-limited by the caller: when the window has not elapsed we report
    // the deferral and the entity comes back for it.
    let synced = false;
    let syncDeferred = false;
    if (cfg.syncEnabled && cmp && cmp.behindBy > 0) {
      if (!args.allowSync) {
        syncDeferred = true;
      } else {
        const result = await syncStagingWithDefault({
          ref,
          repoId: repo.id,
          stagingBranch: cfg.stagingBranch,
          defaultBranch,
          aheadBy: cmp.aheadBy,
        });
        synced = result === "fast_forwarded" || result === "merged";
      }
    }

    if (!cfg.batchPrEnabled) return { synced, syncDeferred };

    // Nothing to ship: do not open an empty PR, and drop a tracked number whose
    // PR has already been merged or closed. A fast-forward lands here too, and
    // correctly: staging now equals the default branch, so there is no batch.
    if (!cmp || cmp.aheadBy === 0) {
      if (repo.stagingBatchPrNumber != null) {
        const tracked = await getPullRequest(ref, repo.stagingBatchPrNumber);
        if (!tracked || tracked.state === "closed") {
          await trackAggregatePr(repo.id, null);
        }
      }
      return { synced, syncDeferred };
    }

    // Build the manifest BEFORE find-or-create, so a PR we open is born with
    // its real contents. GitHub fires `pull_request.opened` with whatever body
    // the create call carried, and that is the snapshot every notification
    // integration quotes: filling the body in afterwards leaves Slack, Discord
    // and email announcing an empty batch that the PR itself no longer shows.
    const prs = await listPullRequests(ref, {
      state: "all",
      base: cfg.stagingBranch,
    });
    // The commits in default...staging ARE the batch, so a PR is in it exactly
    // when its merge commit is one of them. Re-derived on every run, so a
    // dropped webhook cannot leave the manifest stale. The timestamp cutoff is
    // only a fallback for a truncated compare; see selectBatchEntries.
    const since = cmp.mergeBaseDate
      ? new Date(cmp.mergeBaseDate)
      : repo.stagingBatchSince;
    const batchShas = cmp.truncated ? null : new Set(cmp.commitShas);
    if (cmp.truncated) {
      logger.warn(
        { repoId: repo.id, aheadBy: cmp.aheadBy },
        "staging batch compare truncated; falling back to the timestamp cutoff",
      );
    }
    const renderFor = (excludePrNumber: number | null): string =>
      renderBatchBlock(
        selectBatchEntries({
          prs,
          stagingBranch: cfg.stagingBranch,
          since,
          batchShas,
          batchParents: cmp.commitParents,
          excludePrNumber,
        }),
      );

    let aggregate = await findAggregatePr({
      ref,
      repoId: repo.id,
      tracked: repo.stagingBatchPrNumber,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
      batchLabel: project.labelStagingBatch,
    });

    if (!aggregate) {
      // The aggregate PR targets the default branch, so it can never appear in
      // a `base=staging` listing and needs no self-exclusion here.
      const createdBody = renderFor(null);
      const created = await createPullRequest(ref, {
        title: AGGREGATE_PR_TITLE,
        head: cfg.stagingBranch,
        base: defaultBranch,
        body: createdBody,
      });
      if ("failure" in created) {
        if (created.failure === "already_exists") {
          // A concurrent reconcile (or a human) opened it between our list and
          // our create. Look again; if it is still not there, leave it for the
          // next signal rather than spinning.
          aggregate = await findAggregatePr({
            ref,
            repoId: repo.id,
            tracked: null,
            stagingBranch: cfg.stagingBranch,
            defaultBranch,
            batchLabel: project.labelStagingBatch,
          });
        }
        if (!aggregate) {
          logger.info(
            { repoId: repo.id, failure: created.failure },
            "aggregate PR not created",
          );
          return { synced, syncDeferred };
        }
      } else {
        await trackAggregatePr(repo.id, created.number);
        // Synthesized rather than re-fetched: we know exactly what we just
        // created, so this saves a call and, more importantly, makes the body
        // diff below a guaranteed no-op instead of racing a read-back.
        aggregate = {
          number: created.number,
          title: AGGREGATE_PR_TITLE,
          state: "open",
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          body: createdBody,
          baseRef: defaultBranch,
          headRef: cfg.stagingBranch,
          authorLogin: null,
          labels: [],
        };
        logger.info(
          { repoId: repo.id, prNumber: created.number },
          "opened aggregate staging PR",
        );
      }
    }

    if (repo.stagingBatchPrNumber !== aggregate.number) {
      await trackAggregatePr(repo.id, aggregate.number);
    }

    if (!aggregate.labels.includes(project.labelStagingBatch)) {
      await ensureLabel(
        ref,
        project.labelStagingBatch,
        "0b6bcb",
        "Aggregate PR shipping the staging batch to the default branch",
      );
      await addLabel(ref, aggregate.number, project.labelStagingBatch);
    }

    const nextBody = applyBatchBlock(
      aggregate.body,
      renderFor(aggregate.number),
    );
    // Only write when the rendered result differs: every PATCH is a visible
    // edit in the PR timeline, and reconciles are frequent. A PR we just
    // created already carries this exact body, so opening one costs no edit.
    if (nextBody !== (aggregate.body ?? "")) {
      await updatePullRequestBody(ref, aggregate.number, nextBody);
      logger.debug(
        { repoId: repo.id, prNumber: aggregate.number },
        "refreshed aggregate PR manifest",
      );
    }
    return { synced, syncDeferred };
  } catch (e) {
    logger.warn({ err: e, repoId: args.repoId }, "reconcileStagingBatch failed");
    return NOTHING_DONE;
  }
}

/**
 * The aggregate PR itself closed. Clear the tracking so the next staging
 * activity opens a fresh one, and when it merged, record the merge time so the
 * next batch's manifest excludes everything this one already shipped.
 *
 * Returns true when the closing PR was the aggregate PR.
 */
export async function handleAggregatePrClosed(args: {
  repoId: string;
  prNumber: number;
  merged: boolean;
  mergedAt: Date | null;
}): Promise<boolean> {
  const repo = await prisma.repo.findUnique({
    where: { id: args.repoId },
    select: { stagingBatchPrNumber: true },
  });
  if (!repo || repo.stagingBatchPrNumber !== args.prNumber) return false;
  await prisma.repo.update({
    where: { id: args.repoId },
    data: {
      stagingBatchPrNumber: null,
      ...(args.merged ? { stagingBatchSince: args.mergedAt ?? new Date() } : {}),
    },
  });
  logger.info(
    { repoId: args.repoId, prNumber: args.prNumber, merged: args.merged },
    "aggregate staging PR closed",
  );
  return true;
}
