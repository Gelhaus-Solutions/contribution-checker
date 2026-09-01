import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { matchesAnyPattern } from "@/lib/applications/decide-pr";
import { STAGING_SYNC_WINDOW_MS } from "@/lib/temporal/contracts";
import {
  buildStagingDigest,
  parseDigestSections,
  renderDigestLines,
  type BatchOverview,
  type DigestSectionId,
  type StagingDigest,
} from "@/lib/github/staging-digest";
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
  type CompareResult,
  type PrSummary,
  type RepoRef,
} from "@/lib/github/pr-actions";
import {
  loadBatchItemsForRender,
  markBatchShipped,
  syncBatchRecord,
} from "@/lib/qa/batch-record";
import {
  qaAnnotations,
  qaSuffix,
  renderQaLines,
  type QaAnnotation,
  type QaRenderItem,
} from "@/lib/qa/render";
import { parseStandingChecks } from "@/lib/qa/settings";
import { syncQaLabels } from "@/lib/qa/labels";
import { publishQaCheck } from "@/lib/github/check-run";
import { env } from "@/lib/env";

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
  stagingDigestEnabled: boolean;
  stagingDigestSections: string;
  stagingQaEnabled: boolean;
  /** Whether Check Runs publish at all for this project. */
  checksEnabled: boolean;
  qaCheckEnabled: boolean;
  qaFailedLabel: string;
  qaStandingChecks: string;
  stagingBranch: string;
  labelStagingBatch: string;
  labelStagingIgnore: string;
  labelStagingRepoint: string;
};

/** The per-repo overrides. Null on any field means "inherit the project". */
export type StagingRepoOverrides = {
  stagingRetargetEnabled: boolean | null;
  stagingBatchPrEnabled: boolean | null;
  stagingSyncEnabled: boolean | null;
  stagingDigestEnabled: boolean | null;
  stagingQaEnabled: boolean | null;
  stagingBranch: string | null;
};

export const stagingProjectSelect = {
  id: true,
  bypassHandles: true,
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: true,
  stagingDigestEnabled: true,
  stagingDigestSections: true,
  stagingQaEnabled: true,
  checksEnabled: true,
  qaCheckEnabled: true,
  qaFailedLabel: true,
  qaStandingChecks: true,
  stagingBranch: true,
  labelStagingBatch: true,
  labelStagingIgnore: true,
  labelStagingRepoint: true,
} as const;

export const stagingRepoSelect = {
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingSyncEnabled: true,
  stagingDigestEnabled: true,
  stagingQaEnabled: true,
  stagingBranch: true,
} as const;

/** The settings actually in force for one repo, after overrides. */
export type ResolvedStagingConfig = {
  retargetEnabled: boolean;
  batchPrEnabled: boolean;
  /** Keep staging current with the default branch, with no PR. */
  syncEnabled: boolean;
  /** Append the "before you merge" digest to the aggregate PR body. */
  digestEnabled: boolean;
  /** Which digest sections print. Empty when the digest is off. */
  digestSections: Set<DigestSectionId>;
  /** Track, per item in the batch, whether anyone has verified it. */
  qaEnabled: boolean;
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
    digestEnabled: boolean;
    qaEnabled: boolean;
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
    | "stagingDigestEnabled"
    | "stagingDigestSections"
    | "stagingQaEnabled"
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
  // Gated on `batchPrEnabled`, not on `anyEnabled`: the digest is part of the
  // aggregate PR's body and has nowhere else to go, so a repo that only
  // retargets has nothing to print it on.
  const digestEnabled =
    batchPrEnabled &&
    (repo?.stagingDigestEnabled ?? project.stagingDigestEnabled);
  // Same gate, same reason: QA is recorded against the batch, and a repo that
  // only retargets has no batch to record it against.
  const qaEnabled =
    batchPrEnabled && (repo?.stagingQaEnabled ?? project.stagingQaEnabled);
  return {
    retargetEnabled,
    batchPrEnabled,
    syncEnabled:
      anyEnabled && (repo?.stagingSyncEnabled ?? project.stagingSyncEnabled),
    digestEnabled,
    digestSections: digestEnabled
      ? parseDigestSections(project.stagingDigestSections)
      : new Set<DigestSectionId>(),
    qaEnabled,
    stagingBranch: branch || project.stagingBranch,
    anyEnabled,
    overridden: {
      retargetEnabled: repo?.stagingRetargetEnabled != null,
      batchPrEnabled: repo?.stagingBatchPrEnabled != null,
      syncEnabled: repo?.stagingSyncEnabled != null,
      digestEnabled: repo?.stagingDigestEnabled != null,
      qaEnabled: repo?.stagingQaEnabled != null,
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
  /** When it merged into staging. Optional because only the batch overview
   * reads it, and it is best-effort even there: GitHub has been known to
   * return a merged PR with no `merged_at`. */
  mergedAt?: string | null;
};

/**
 * Render the manifest block. Kept pure and exported so the formatting is
 * testable on its own, the same way `buildDecisionCheckPayload` is split from
 * `publishDecisionCheck`.
 *
 * The optional digest is the second half of the answer. The PR list says which
 * changes ship; the digest says what shipping them costs the operator: the
 * environment variables that have to exist first, the migrations that have to
 * run, the dependencies and infrastructure that moved. It is omitted entirely
 * when the compare turned up nothing notable, so a quiet batch stays a short
 * body.
 */
export function renderBatchBlock(
  entries: BatchEntry[],
  digest?: StagingDigest | null,
  sections?: ReadonlySet<DigestSectionId>,
  /**
   * QA state, when the project records it. `badges` annotate the manifest lines
   * in place; `lines` are the short section underneath. The status goes on the
   * line that already names the PR rather than into a second list of the same
   * PRs, which is all a reader would have to scroll past to learn one word each.
   */
  qa?: {
    badges?: ReadonlyMap<number, QaAnnotation>;
    lines?: string[];
  },
): string {
  const lines =
    entries.length === 0
      ? ["_No merged PRs in this batch yet._"]
      : entries.map((e) => {
          // No title: GitHub expands the `#123` reference into the PR's title
          // when it renders, so carrying our own copy only duplicated it.
          const by = e.author ? ` by @${e.author}` : "";
          const annotation = qa?.badges?.get(e.number);
          const verdict = annotation ? qaSuffix(annotation) : "";
          return `- #${e.number}${by}${verdict}`;
        });
  const digestLines = digest ? renderDigestLines(digest, sections) : [];
  const heads =
    digestLines.length === 0
      ? []
      : ["", "### Before you merge", "", ...digestLines];
  // Last, because it is the part that changes most often. Keeping it at the
  // bottom means a verdict does not reflow the manifest above it in the diff
  // GitHub shows for the edit.
  const qaLines = qa?.lines ?? [];
  const qaSection =
    qaLines.length === 0 ? [] : ["", "### QA", "", ...qaLines];
  return [
    BLOCK_START,
    "### In this batch",
    "",
    ...lines,
    ...heads,
    ...qaSection,
    BLOCK_END,
  ].join("\n");
}

/**
 * Reduce the manifest entries to the batch overview. Kept here rather than in
 * the digest module because it reads `BatchEntry`, which is a manifest concept:
 * the digest describes the diff, and the diff does not know which PRs produced
 * it.
 */
export function batchOverview(entries: BatchEntry[]): BatchOverview {
  const authors = [
    ...new Set(entries.map((e) => e.author).filter((a): a is string => !!a)),
  ].sort();
  const merged = entries
    .map((e) => e.mergedAt)
    .filter((m): m is string => !!m)
    .sort();
  return {
    prCount: entries.length,
    authors,
    firstMergedAt: merged[0] ?? null,
    lastMergedAt: merged[merged.length - 1] ?? null,
  };
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
  | "ignore_label"
  | "repoint_label"
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
  ignoreLabel: string;
  repointLabel: string;
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
  // Both escape hatches stop a retarget; only one of them also moves the PR
  // (see `repointRequestsRevert`). Ignore is checked first so a PR carrying
  // both is reported as the label that wins.
  if (stagingIgnored({ prLabels: args.prLabels, ignoreLabel: args.ignoreLabel })) {
    return "ignore_label";
  }
  if (args.prLabels.includes(args.repointLabel)) return "repoint_label";
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
 * Does this PR carry the "leave it entirely alone" label?
 *
 * The strongest of the two escape hatches, and the only one that promises the
 * bot will not *move* the PR: no retarget onto staging, and no repoint off it
 * either. It exists because the other label answers a different question. A
 * maintainer asking the bot to stop having an opinion about a base should not
 * have the PR rebased out from under them as the price of asking, which is
 * exactly what the single label used to do to a PR already on staging.
 *
 * It governs routing, not membership: a PR already merged into staging still
 * ships in the batch and is still listed in the manifest, because the manifest
 * is a record of what the release contains and this label cannot change that.
 */
export function stagingIgnored(args: {
  prLabels: string[];
  ignoreLabel: string;
}): boolean {
  return args.prLabels.includes(args.ignoreLabel);
}

/**
 * Does the repoint label want a PR the bot already moved put back?
 *
 * `stagingRetargetSkipReason` only ever *prevents* a retarget, so labelling a
 * PR that is already on staging did nothing: the base is no longer the default
 * branch, so every later pass short-circuits on `base_not_default` and the PR
 * ships in the batch anyway. This label has to work in both directions to mean
 * what it says.
 *
 * The ignore label beats it. Both together read as "do not move this" and "move
 * this", and the half that does nothing is the safe one to honor: a PR left
 * where it is can still be moved by hand, a PR moved by mistake has already
 * lost its base.
 *
 * Pure, and says nothing about where the PR should go: the `StagingRetarget`
 * record answers that (the base it was opened against), and the default branch
 * is the fallback when the bot never moved it. See `revertRetarget`.
 */
export function repointRequestsRevert(args: {
  baseRef: string;
  stagingBranch: string;
  prLabels: string[];
  repointLabel: string;
  ignoreLabel: string;
}): boolean {
  if (stagingIgnored({ prLabels: args.prLabels, ignoreLabel: args.ignoreLabel })) {
    return false;
  }
  return (
    args.prLabels.includes(args.repointLabel) &&
    args.baseRef === args.stagingBranch
  );
}

/**
 * Take a PR carrying the repoint label off the staging branch. Returns the
 * outcome, or null when there is nothing to move.
 *
 * Two cases, and the difference is only where the PR goes:
 *
 *  - `repoint_reverted`: the bot moved this PR, so a `StagingRetarget` row
 *    says which base it was opened against, and that is where it goes back to.
 *  - `repoint_rerouted`: there is no row, because the PR was opened against
 *    staging directly (gitroomhq/postiz-app#1993) or reached it some other way.
 *    It goes to the default branch.
 *
 * The row used to be the whole safety condition, on the grounds that
 * redirecting a deliberate staging PR at the default branch is a release
 * decision rather than a routing one. That reasoning was wrong about who is
 * speaking: only a user with write access can label a PR, the label means "this
 * must not ship in the batch" in the settings UI, and refusing to act on it
 * left the label doing *nothing at all* on the PRs maintainers actually reach
 * for it on. A maintainer who wants the PR left exactly where it is has the
 * ignore label for that, which is the whole reason the two are separate.
 *
 * A reroute with no row still requires retargeting to be enabled here: undoing
 * a write the bot made must survive the switch being turned off afterwards, but
 * forming a new opinion about a PR's base must not happen in a repo that has
 * opted out of routing altogether.
 *
 * Loop-safe like the retarget itself: our PATCH echoes back as
 * `pull_request.edited` with the base already off staging, where
 * `repointRequestsRevert` is false and `stagingRetargetSkipReason` returns
 * `repoint_label` before anything can move it again.
 */
async function revertRetarget(args: {
  repoId: string;
  ghRepoId: number;
  ref: RepoRef;
  prNumber: number;
  stagingBranch: string;
  defaultBranch: string;
  /** May a PR with no retarget record be moved? See above. */
  routingEnabled: boolean;
}): Promise<
  "repoint_reverted" | "repoint_rerouted" | "repoint_impossible" | null
> {
  const record = await prisma.stagingRetarget.findUnique({
    where: {
      repoId_prNumber: { repoId: args.repoId, prNumber: args.prNumber },
    },
    select: { fromBase: true },
  });
  // A row whose `fromBase` is staging itself would be a no-op move; fall back
  // to the default branch rather than PATCHing the base to what it already is.
  const recorded =
    record && record.fromBase !== args.stagingBranch ? record.fromBase : null;
  const target = recorded ?? (args.routingEnabled ? args.defaultBranch : null);
  if (!target || target === args.stagingBranch) return null;

  try {
    await setPullRequestBase(args.ref, args.prNumber, target);
  } catch (e) {
    // Staging has since been merged into the target base, so the PR would have
    // no diff against it. Any record is kept: the PR is still on staging, and a
    // later push may make the move possible after all.
    if (isNoNewCommitsError(e)) {
      logger.warn(
        {
          ghRepoId: args.ghRepoId,
          prNumber: args.prNumber,
          target,
        },
        `staging repoint impossible: the PR has no diff against ` +
          `${target} any more. It stays on staging; move it by hand ` +
          `if it must not ship in the batch.`,
      );
      return "repoint_impossible";
    }
    throw e;
  }

  // Dropped only once the PR is actually off staging, so a failed move stays
  // retryable and a later retarget writes a fresh row.
  if (record) {
    await prisma.stagingRetarget.delete({
      where: {
        repoId_prNumber: { repoId: args.repoId, prNumber: args.prNumber },
      },
    });
  }
  logger.info(
    {
      ghRepoId: args.ghRepoId,
      prNumber: args.prNumber,
      from: args.stagingBranch,
      to: target,
      recorded: !!recorded,
    },
    recorded
      ? "reverted staging retarget: PR carries the repoint label"
      : "moved PR off staging: it carries the repoint label and the bot " +
        "never retargeted it",
  );
  return recorded ? "repoint_reverted" : "repoint_rerouted";
}

/**
 * Ping-pong fuse. "Rewrite the base back unless label-exempt" is, against a
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
export function selectBatchPrs(args: {
  prs: PrSummary[];
  stagingBranch: string;
  since: Date | null;
  /** Commits in `default...staging`, or null when membership is unknowable. */
  batchShas: Set<string> | null;
  /** sha -> parents, for the same commit range. */
  batchParents: Record<string, string[]> | null;
  excludePrNumber: number | null;
}): PrSummary[] {
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
  return kept;
}

/**
 * The manifest's view of the batch: PR number, author, merge time.
 *
 * Split from `selectBatchPrs` because the QA record needs the whole `PrSummary`
 * (title, body, labels, merge commit) and the manifest needs almost none of it.
 * Both read the same membership decision, so they cannot disagree about which
 * PRs are in the batch, which is the property worth protecting here.
 */
export function selectBatchEntries(args: {
  prs: PrSummary[];
  stagingBranch: string;
  since: Date | null;
  batchShas: Set<string> | null;
  batchParents: Record<string, string[]> | null;
  excludePrNumber: number | null;
}): BatchEntry[] {
  return selectBatchPrs(args).map((pr) => ({
    number: pr.number,
    author: pr.authorLogin,
    mergedAt: pr.mergedAt,
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
  | "repoint_reverted"
  | "repoint_rerouted"
  | "repoint_impossible"
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

    // A closed PR can never be retargeted, so routing stops here. It is still
    // *in* the batch though, and its description is still the source of the QA
    // steps and the issues it closes, so the caller has to be told where it
    // sits or the manifest and the QA record go stale.
    //
    // This is not hypothetical: writing the `## QA` section after the PR merged
    // is the normal case, and returning early with `touchesStaging: false` here
    // meant that edit reached nothing.
    if (ctx.prIsClosed) {
      return {
        repoId: repo.id,
        retargeted: false,
        isAggregatePr: false,
        touchesStaging: ctx.baseRef === cfg.stagingBranch,
        outcome: "pr_closed",
      };
    }

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
    // "Leave this PR alone", and the earliest possible exit so that it means
    // it: before the repoint branch below, which would move the PR, and before
    // `retargetEnabled`, which is a project switch and cannot answer a question
    // asked about one PR. Nothing after this point writes to the PR.
    //
    // The aggregate PR is exempt from both labels: it lives on staging by
    // design, it is the bot's own, and it is recognized structurally, so a
    // label on it can only be someone's mistake.
    if (
      !isAggregate &&
      stagingIgnored({
        prLabels: ctx.prLabels,
        ignoreLabel: project.labelStagingIgnore,
      })
    ) {
      logger.info(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
        "staging routing skipped: PR carries the staging ignore label",
      );
      return { ...base, retargeted: false, outcome: "ignore_label" };
    }

    // The repoint label applied after the fact. Checked before
    // `retargetEnabled`, because it can be undoing a write the bot already
    // made: turning retargeting off afterwards must not strand a PR on staging
    // that has been explicitly taken out of the batch. (A PR the bot never
    // moved is a different case and `revertRetarget` gates it on the switch
    // itself.)
    if (
      !isAggregate &&
      repointRequestsRevert({
        baseRef: ctx.baseRef,
        stagingBranch: cfg.stagingBranch,
        prLabels: ctx.prLabels,
        repointLabel: project.labelStagingRepoint,
        ignoreLabel: project.labelStagingIgnore,
      })
    ) {
      const outcome = await revertRetarget({
        repoId: repo.id,
        ghRepoId: ctx.ghRepoId,
        ref,
        prNumber: ctx.prNumber,
        stagingBranch: cfg.stagingBranch,
        defaultBranch,
        routingEnabled: cfg.retargetEnabled,
      });
      if (outcome) return { ...base, retargeted: false, outcome };
    }

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
      ignoreLabel: project.labelStagingIgnore,
      repointLabel: project.labelStagingRepoint,
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
          `default branch repeatedly. Add the staging ignore label to settle ` +
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
    // Remember where it came from, so the repoint label can put it back. Best
    // effort on purpose: the PR is already moved, and a bookkeeping row is not
    // worth failing the routing pass (and with it the batch signal) over.
    try {
      await prisma.stagingRetarget.upsert({
        where: {
          repoId_prNumber: { repoId: repo.id, prNumber: ctx.prNumber },
        },
        create: {
          repoId: repo.id,
          prNumber: ctx.prNumber,
          fromBase: ctx.baseRef,
          toBase: cfg.stagingBranch,
        },
        update: { fromBase: ctx.baseRef, toBase: cfg.stagingBranch },
      });
    } catch (e) {
      logger.warn(
        { err: e, ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
        "staging retarget recorded on GitHub but not in the database: the " +
          "repoint label will send this PR to the default branch rather than " +
          "the base it was opened against",
      );
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

/** Stamp the moment staging was actually moved, which is what the sync
 * batching window is measured from. Best-effort: a lost write costs one extra
 * merge commit, never correctness. */
async function recordStagingSync(repoId: string) {
  await prisma.repo
    .update({ where: { id: repoId }, data: { stagingLastSyncAt: new Date() } })
    .catch((e) =>
      logger.warn({ err: e, repoId }, "staging sync timestamp write failed"),
    );
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
  /** Epoch ms at which the deferred sync becomes eligible. Null unless
   * `syncDeferred`; the entity sleeps until then instead of idling out. */
  syncEligibleAtMs: number | null;
};

const NOTHING_DONE: StagingReconcileResult = {
  synced: false,
  syncDeferred: false,
  syncEligibleAtMs: null,
};

/**
 * Reduce the compare into the "before you merge" digest, or null when it could
 * not be built. Every part of this is heuristic and advisory, so it is wrapped:
 * a regex that trips over an odd patch must cost the release PR its digest,
 * never its manifest.
 */
function safeDigest(cmp: CompareResult, repoId: string): StagingDigest | null {
  try {
    return buildStagingDigest({
      files: cmp.files ?? [],
      commits: (cmp.commitShas ?? []).map((sha) => ({
        sha,
        message: cmp.commitMessages?.[sha] ?? "",
      })),
      filesTruncated: cmp.filesTruncated ?? false,
    });
  } catch (e) {
    logger.warn({ err: e, repoId }, "staging digest build failed");
    return null;
  }
}

/**
 * Update the QA record and render its lines, or print nothing.
 *
 * Wrapped for the same reason `safeDigest` is, and it matters more here because
 * this one writes to the database: a failed upsert, a lock timeout or a bad row
 * must cost the release PR its QA section and nothing else. The manifest is the
 * part of the body that has to survive every bug in the parts around it.
 */
type QaPass = {
  batchId: string;
  items: QaRenderItem[];
  badges: Map<number, QaAnnotation>;
  lines: string[];
};

async function safeQa(args: {
  repoId: string;
  projectId: string;
  prs: PrSummary[];
  standingChecks: string[];
  aggregatePrNumber: number | null;
}): Promise<QaPass | null> {
  try {
    const result = await syncBatchRecord(args);
    const items = await loadBatchItemsForRender(result.batchId);
    if (result.regressed) {
      // Worth its own log line: the batch was green, somebody merged more work
      // into staging, and the release PR's checks were about to say "ready".
      logger.info(
        { repoId: args.repoId, batchId: result.batchId, added: result.added },
        "staging batch regressed: new items landed in a verified batch",
      );
    }
    return {
      batchId: result.batchId,
      items,
      badges: qaAnnotations(items),
      lines: renderQaLines(items),
    };
  } catch (e) {
    logger.warn({ err: e, repoId: args.repoId }, "staging QA record failed");
    return null;
  }
}

/**
 * Put the QA verdict where GitHub can act on it: the check branch protection
 * reads, and a label on both the PR that failed and the release PR carrying it.
 *
 * The label is applied and removed rather than only applied, so it describes the
 * current state instead of accumulating. Both directions are idempotent, and the
 * whole thing is swallowed: QA feedback is advisory, the aggregate PR is not.
 */
async function safeQaGithub(args: {
  ref: RepoRef;
  repoId: string;
  installationId: number;
  repoFullName: string;
  project: { id: string; checksEnabled: boolean; qaCheckEnabled: boolean };
  failedLabel: string;
  stagingBranch: string;
  aggregatePrNumber: number;
  pass: QaPass;
}): Promise<void> {
  try {
    // The batch is recorded before the aggregate PR is found or created, so
    // this is the first point at which its number is known. Stamping it now
    // means the board links to the release on the same pass rather than the
    // next one.
    await prisma.stagingBatch.updateMany({
      where: { id: args.pass.batchId, prNumber: null },
      data: { prNumber: args.aggregatePrNumber },
    });

    const boardUrl =
      `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}` +
      `/dashboard/projects/${args.project.id}/qa?repo=${args.repoId}`;

    // The aggregate PR's head IS the staging branch, so its tip is the SHA the
    // check belongs on. `PrSummary` does not carry a head sha, and this is one
    // cheap call rather than widening that type for every caller.
    const headSha = await getBranchSha(args.ref, args.stagingBranch);
    await publishQaCheck({
      installationId: args.installationId,
      repoFullName: args.repoFullName,
      batchId: args.pass.batchId,
      headSha,
      project: args.project,
      items: args.pass.items,
      boardUrl,
    });

    await syncQaLabels({
      ref: args.ref,
      batchId: args.pass.batchId,
      failedLabel: args.failedLabel,
      aggregatePrNumber: args.aggregatePrNumber,
    });
  } catch (e) {
    logger.warn({ err: e, repoId: args.repoId }, "staging QA feedback failed");
  }
}

/**
 * Re-derive a repo's aggregate staging PR from live GitHub state: ensure it
 * exists while staging is ahead, and keep its manifest block accurate. Called
 * only from the per-repo `stagingBatch` entity workflow, so runs for one repo
 * never overlap. Never throws.
 */
export async function reconcileStagingBatch(args: {
  repoId: string;
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
        stagingLastSyncAt: true,
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
    // is rate-limited here, against the last sync recorded on the repo row:
    // inside the window we report the deferral along with the moment it lifts,
    // and the entity comes back for it then. The timestamp lives in the
    // database rather than in the entity because the entity completes once the
    // batch settles, and a fresh run would sync on the very next push.
    let synced = false;
    let syncDeferred = false;
    let syncEligibleAtMs: number | null = null;
    if (cfg.syncEnabled && cmp && cmp.behindBy > 0) {
      const eligibleAt =
        repo.stagingLastSyncAt == null
          ? 0
          : repo.stagingLastSyncAt.getTime() + STAGING_SYNC_WINDOW_MS;
      if (Date.now() < eligibleAt) {
        syncDeferred = true;
        syncEligibleAtMs = eligibleAt;
      } else {
        const result = await syncStagingWithDefault({
          ref,
          repoId: repo.id,
          stagingBranch: cfg.stagingBranch,
          defaultBranch,
          aheadBy: cmp.aheadBy,
        });
        synced = result === "fast_forwarded" || result === "merged";
        // Only a write opens a new window. "up_to_date" and every failure
        // leave the old one, so a conflict a human has just resolved is picked
        // up on the next request rather than hours later.
        if (synced) await recordStagingSync(repo.id);
      }
    }
    const paced: StagingReconcileResult = {
      synced,
      syncDeferred,
      syncEligibleAtMs,
    };

    if (!cfg.batchPrEnabled) return paced;

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
      return paced;
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
    // Derived from the compare we already have, so the whole digest is free:
    // the response carries the changed files and the commit messages whether
    // we read them or not. Degrades to no digest rather than throwing: the
    // manifest is the part of the body that must never be lost to a parsing
    // bug in the part that is only advisory.
    // Built once, off the compare, and reused: scanning the patches does not
    // depend on which PR we exclude. Null when the project has the digest off,
    // which is also the point at which the work is skipped entirely.
    const baseDigest = cfg.digestEnabled ? safeDigest(cmp, repo.id) : null;

    // The QA record is derived from the same membership decision as the
    // manifest, so the two can never disagree about what is in the batch. It is
    // synced BEFORE the body renders, because the QA section is part of that
    // body and a PR we are about to open should be born carrying it.
    //
    // Wrapped like the digest is: QA bookkeeping is advisory, the manifest is
    // not. A bug in here must never cost the release PR its list of PRs.
    const qa = cfg.qaEnabled
      ? await safeQa({
          repoId: repo.id,
          projectId: project.id,
          prs: selectBatchPrs({
            prs,
            stagingBranch: cfg.stagingBranch,
            since,
            batchShas,
            batchParents: cmp.commitParents,
            excludePrNumber: repo.stagingBatchPrNumber,
          }),
          standingChecks: parseStandingChecks(project.qaStandingChecks),
          aggregatePrNumber: repo.stagingBatchPrNumber,
        })
      : null;

    const renderFor = (excludePrNumber: number | null): string => {
      const entries = selectBatchEntries({
        prs,
        stagingBranch: cfg.stagingBranch,
        since,
        batchShas,
        batchParents: cmp.commitParents,
        excludePrNumber,
      });
      return renderBatchBlock(
        entries,
        baseDigest && { ...baseDigest, overview: batchOverview(entries) },
        cfg.digestSections,
        qa ? { badges: qa.badges, lines: qa.lines } : undefined,
      );
    };

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
          return paced;
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

    // Last, because it needs the aggregate PR's number, which only exists once
    // the find-or-create above has settled.
    if (qa) {
      await safeQaGithub({
        ref,
        repoId: repo.id,
        installationId: repo.installationId,
        repoFullName: repo.fullName,
        project: {
          id: project.id,
          checksEnabled: project.checksEnabled,
          qaCheckEnabled: project.qaCheckEnabled,
        },
        failedLabel: project.qaFailedLabel,
        stagingBranch: cfg.stagingBranch,
        aggregatePrNumber: aggregate.number,
        pass: qa,
      });
    }

    return paced;
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
    select: { stagingBatchPrNumber: true, projectId: true },
  });
  if (!repo || repo.stagingBatchPrNumber !== args.prNumber) return false;
  await prisma.repo.update({
    where: { id: args.repoId },
    data: {
      stagingBatchPrNumber: null,
      ...(args.merged ? { stagingBatchSince: args.mergedAt ?? new Date() } : {}),
    },
  });

  // Only a merge ships a batch. A close without merging leaves the commits
  // exactly where they were, so the next reconcile opens a fresh aggregate PR
  // over the same content and the QA already recorded against it still holds:
  // freezing the batch here would throw that work away and start the release
  // over from nothing verified.
  if (args.merged) {
    await markBatchShipped({
      repoId: args.repoId,
      projectId: repo.projectId,
      prNumber: args.prNumber,
      shippedAt: args.mergedAt ?? new Date(),
    }).catch((e) =>
      logger.warn({ err: e, repoId: args.repoId }, "qa batch ship record failed"),
    );
  }

  logger.info(
    { repoId: args.repoId, prNumber: args.prNumber, merged: args.merged },
    "aggregate staging PR closed",
  );
  return true;
}
