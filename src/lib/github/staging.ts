import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { matchesAnyPattern } from "@/lib/applications/decide-pr";
import {
  addLabel,
  compareBranches,
  createBranch,
  createPullRequest,
  ensureLabel,
  getBranchSha,
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
  stagingBranch: string;
  labelStagingBatch: string;
  labelStagingOptOut: string;
};

/** The per-repo overrides. Null on any field means "inherit the project". */
export type StagingRepoOverrides = {
  stagingRetargetEnabled: boolean | null;
  stagingBatchPrEnabled: boolean | null;
  stagingBranch: string | null;
};

export const stagingProjectSelect = {
  id: true,
  bypassHandles: true,
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingBranch: true,
  labelStagingBatch: true,
  labelStagingOptOut: true,
} as const;

export const stagingRepoSelect = {
  stagingRetargetEnabled: true,
  stagingBatchPrEnabled: true,
  stagingBranch: true,
} as const;

/** The settings actually in force for one repo, after overrides. */
export type ResolvedStagingConfig = {
  retargetEnabled: boolean;
  batchPrEnabled: boolean;
  stagingBranch: string;
  /** Which fields the repo overrode, for the settings UI to show. */
  overridden: {
    retargetEnabled: boolean;
    batchPrEnabled: boolean;
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
    "stagingRetargetEnabled" | "stagingBatchPrEnabled" | "stagingBranch"
  >,
  repo: StagingRepoOverrides | null,
): ResolvedStagingConfig {
  const branch = repo?.stagingBranch?.trim();
  return {
    retargetEnabled:
      repo?.stagingRetargetEnabled ?? project.stagingRetargetEnabled,
    batchPrEnabled:
      repo?.stagingBatchPrEnabled ?? project.stagingBatchPrEnabled,
    stagingBranch: branch || project.stagingBranch,
    overridden: {
      retargetEnabled: repo?.stagingRetargetEnabled != null,
      batchPrEnabled: repo?.stagingBatchPrEnabled != null,
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
  title: string;
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
          const title = e.title.trim() || `PR #${e.number}`;
          const by = e.author ? ` by @${e.author}` : "";
          return `- ${title} (#${e.number}${by})`;
        });
  return [
    BLOCK_START,
    "### In this batch",
    "",
    ...lines,
    "",
    "_Updated automatically by contribution-checker._",
    BLOCK_END,
  ].join("\n");
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
}): string | null {
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
 * Which PRs belong in the current batch: only those actually merged into
 * staging, and only those merged strictly after `since`, since anything at or
 * before it is already contained in the default branch.
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
  excludePrNumber: number | null;
}): BatchEntry[] {
  const kept = args.prs.filter((pr) => {
    if (pr.number === args.excludePrNumber) return false;
    if (pr.baseRef !== args.stagingBranch) return false;
    if (!pr.merged) return false; // open, or closed without merging
    if (!args.since) return true;
    return pr.mergedAt != null && new Date(pr.mergedAt) > args.since;
  });
  // Ascending PR number reads as chronological and keeps the body stable
  // across reconciles (the list endpoint sorts by updated-at, which churns).
  kept.sort((a, b) => a.number - b.number);
  return kept.map((pr) => ({
    number: pr.number,
    title: pr.title,
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
};

const NO_ROUTING: StagingRoutingResult = {
  repoId: null,
  retargeted: false,
  isAggregatePr: false,
  touchesStaging: false,
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
    if (ctx.prIsClosed) return NO_ROUTING;
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
      return NO_ROUTING;
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
      return { ...base, retargeted: false };
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
      logger.debug(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber, skip },
        "staging retarget skipped",
      );
      return { ...base, retargeted: false };
    }

    if (fuseTripped(`${ctx.ghRepoId}#${ctx.prNumber}`)) {
      logger.warn(
        { ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
        `staging retarget fuse tripped: the base has been moved back to the ` +
          `default branch repeatedly. Add the staging opt-out label to settle ` +
          `it, or check for another automation enforcing the base.`,
      );
      return { ...base, retargeted: false };
    }

    const ready = await ensureStagingBranch({
      ref,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
    });
    if (!ready) return { ...base, retargeted: false };

    await setPullRequestBase(ref, ctx.prNumber, cfg.stagingBranch);
    logger.info(
      {
        ghRepoId: ctx.ghRepoId,
        prNumber: ctx.prNumber,
        from: defaultBranch,
        to: cfg.stagingBranch,
      },
      "retargeted PR to staging",
    );
    return { ...base, retargeted: true, touchesStaging: true };
  } catch (e) {
    logger.warn(
      { err: e, ghRepoId: ctx.ghRepoId, prNumber: ctx.prNumber },
      "applyStagingRouting failed",
    );
    return NO_ROUTING;
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

/**
 * Re-derive a repo's aggregate staging PR from live GitHub state: ensure it
 * exists while staging is ahead, and keep its manifest block accurate. Called
 * only from the per-repo `stagingBatch` entity workflow, so runs for one repo
 * never overlap. Never throws.
 */
export async function reconcileStagingBatch(args: {
  repoId: string;
}): Promise<void> {
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
    if (!repo || !repo.active || repo.installationId == null) return;
    const project = repo.project;
    const cfg = resolveStagingConfig(project, repo);
    if (!cfg.batchPrEnabled) return;

    const ref = repoRef(repo.fullName, repo.installationId);
    const defaultBranch = await resolveDefaultBranch({
      repoId: repo.id,
      ref,
      hint: null,
      cached: repo.defaultBranch,
    });
    if (!defaultBranch) return;
    if (defaultBranch === cfg.stagingBranch) {
      logger.warn(
        { repoId: repo.id, branch: defaultBranch },
        "staging batch skipped: staging branch is the default branch",
      );
      return;
    }

    const ready = await ensureStagingBranch({
      ref,
      stagingBranch: cfg.stagingBranch,
      defaultBranch,
    });
    if (!ready) return;

    // Nothing to ship: do not open an empty PR, and drop a tracked number whose
    // PR has already been merged or closed.
    const cmp = await compareBranches(ref, defaultBranch, cfg.stagingBranch);
    if (!cmp || cmp.aheadBy === 0) {
      if (repo.stagingBatchPrNumber != null) {
        const tracked = await getPullRequest(ref, repo.stagingBatchPrNumber);
        if (!tracked || tracked.state === "closed") {
          await trackAggregatePr(repo.id, null);
        }
      }
      return;
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
    // The merge base of default...staging is the exact point everything older
    // is already shipped from, and it is re-derived on every run, so a dropped
    // close webhook cannot leave the cutoff stale. `stagingBatchSince` is the
    // fallback for the rare compare that returns no merge base.
    const since = cmp.mergeBaseDate
      ? new Date(cmp.mergeBaseDate)
      : repo.stagingBatchSince;
    const renderFor = (excludePrNumber: number | null): string =>
      renderBatchBlock(
        selectBatchEntries({
          prs,
          stagingBranch: cfg.stagingBranch,
          since,
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
          return;
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
  } catch (e) {
    logger.warn({ err: e, repoId: args.repoId }, "reconcileStagingBatch failed");
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
