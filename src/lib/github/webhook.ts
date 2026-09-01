import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import * as Sentry from "@sentry/nextjs";
import {
  decideForPR,
  decideForRepo,
  decisionRepoInclude,
  type PrDecision,
} from "@/lib/applications/decide-pr";
import { buildDecisionMessage } from "@/lib/applications/decision-message";
import { enqueueProjectWebhook } from "@/lib/notifications/webhooks";
import {
  closePullRequest,
  commentOnPr,
  ensureLabel,
  removeLabelIfPresent,
  reopenPullRequest,
  setLabels,
  repoRef,
} from "@/lib/github/pr-actions";
import {
  publishDecisionCheck,
  publishClaCheck,
  type ClaCheckState,
} from "@/lib/github/check-run";
import {
  applyStagingRouting,
  handleAggregatePrClosed,
  resolveStagingConfig,
  stagingProjectSelect,
  stagingRepoSelect,
  type StagingRoutingResult,
  type StagingRoutingOutcome,
} from "@/lib/github/staging";
import { signalStagingBatch } from "@/lib/temporal/start";
import { runQualityForPrCheck } from "@/lib/quality/run";
import { getInstallationOctokit } from "@/lib/github/app";
import { verifyDco } from "@/lib/cla/dco";
import { getClaStatus } from "@/lib/cla/status";
import { syncRepoFileClaForPush } from "@/lib/cla/repo-source";
import { contributorInfoUrl } from "@/lib/notifications/email";

type WebhookPayload = {
  action?: string;
  installation?: { id: number };
  repository?: {
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
    default_branch?: string;
  };
  pull_request?: {
    number: number;
    node_id: string;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    user: { login: string; id: number; type: string };
    head?: { sha: string; ref?: string; repo?: { full_name?: string } | null };
    base?: { ref?: string; repo?: { default_branch?: string } };
    labels?: Array<{ name?: string }>;
    title?: string;
    body?: string | null;
  };
  /** Present on `edited`: which fields changed and their previous values. */
  changes?: {
    base?: { ref?: { from?: string } };
    title?: { from?: string };
    /** Present when the description changed; carries the previous text. */
    body?: { from?: string };
  };
  label?: { name: string };
  repositories?: Array<{ id: number; full_name: string }>;
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
};

async function attachInstallationToManualRepos(args: {
  installationId: number;
  repos: Array<{ id: number; full_name: string }>;
}) {
  for (const r of args.repos) {
    await prisma.repo
      .updateMany({
        where: { fullName: r.full_name, installationId: null },
        data: {
          ghRepoId: r.id,
          installationId: args.installationId,
          active: true,
        },
      })
      .catch((e) =>
        logger.warn(
          { err: e, fullName: r.full_name },
          "linking manual repo to installation failed",
        ),
      );
  }
}

/**
 * Fetch a PR's commits and verify the DCO sign-off on each. Defensive: any
 * failure (API error, missing data) resolves to `ok: true` so DCO can never
 * crash the webhook or block a PR on infrastructure problems. The gate only
 * fires on a confident "missing sign-off" result.
 */
async function checkDco(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<{ ok: boolean }> {
  try {
    const octokit = await getInstallationOctokit(args.installationId);
    const commits: { sha: string; message: string }[] = [];
    const COMMIT_PAGE_SIZE = 100;
    const COMMIT_PAGE_LIMIT = 3; // 300 commits max (mirrors quality/fetch.ts)
    for (let page = 1; page <= COMMIT_PAGE_LIMIT; page++) {
      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
        {
          owner: args.owner,
          repo: args.repo,
          pull_number: args.prNumber,
          per_page: COMMIT_PAGE_SIZE,
          page,
        },
      );
      const batch = res.data as Array<{
        sha: string;
        commit?: { message?: string };
      }>;
      for (const c of batch) {
        commits.push({ sha: c.sha, message: c.commit?.message ?? "" });
      }
      if (batch.length < COMMIT_PAGE_SIZE) break;
    }
    // No commits fetched (empty PR / API hiccup) → don't block on DCO.
    if (commits.length === 0) return { ok: true };
    return { ok: verifyDco(commits).ok };
  } catch (e) {
    logger.warn(
      { err: e, owner: args.owner, repo: args.repo, prNumber: args.prNumber },
      "DCO commit check failed; treating as satisfied",
    );
    return { ok: true };
  }
}

/**
 * Layer the DCO gate onto a decision. DCO is independent of CLA and needs the
 * PR's commits (which the decision pipeline doesn't load), so it is applied
 * here. It only fires when the base outcome already lets the PR proceed (a
 * non-checker-disabled APPROVED, or a collaborator BYPASS) or is already a CLA
 * CHECK_REQUIRED. When DCO fails on an otherwise-allowing decision we override
 * to CHECK_REQUIRED{dco_missing}; when CLA is already failing, CLA keeps the
 * gate reason. Fully defensive: checkDco never throws. Shared by the
 * pull_request and merge_group handlers.
 */
async function applyDcoGate(args: {
  decision: PrDecision & { repoId?: string; projectId?: string };
  dcoEnabled: boolean;
  installationId: number;
  repoFullName: string;
  prNumber: number;
}): Promise<PrDecision & { repoId?: string; projectId?: string }> {
  const { decision } = args;
  if (!args.dcoEnabled) return decision;
  const claGateActive =
    decision.status === "CHECK_REQUIRED" &&
    (decision.reason === "cla_required" || decision.reason === "cla_stale");
  const baseAllows =
    (decision.status === "APPROVED" &&
      decision.bypassReason !== "checker_disabled") ||
    (decision.status === "BYPASSED" && decision.reason === "collaborator");
  if (!(baseAllows || claGateActive)) return decision;
  const [owner, name] = args.repoFullName.split("/");
  if (!owner || !name) return decision;
  const dco = await checkDco({
    installationId: args.installationId,
    owner,
    repo: name,
    prNumber: args.prNumber,
  });
  if (!dco.ok && baseAllows) {
    // CLA was satisfied (or not required) but DCO is missing → gate on DCO.
    return {
      status: "CHECK_REQUIRED",
      reason: "dco_missing",
      repoId: decision.repoId,
      projectId: decision.projectId,
    };
  }
  // If claGateActive and DCO also fails, CLA wins the reason; the
  // CHECK_REQUIRED comment copy covers DCO guidance separately.
  return decision;
}

/**
 * Compute the dedicated CLA-check state for a PR author, independent of the
 * overall decision outcome, so the `contribution-checker / cla` check is
 * accurate even on paths where the decision short-circuited before the CLA
 * layer. Returns null when the project has no CLA enabled. Shared by the
 * pull_request and merge_group handlers.
 */
async function resolveClaState(args: {
  project: { id: string; claEnabled: boolean; claRequired: boolean };
  decision: PrDecision;
  authorGhId: number;
  authorGhLogin: string;
}): Promise<ClaCheckState | null> {
  const { project, decision } = args;
  if (!project.claEnabled) return null;
  const disabledByChecker =
    decision.status === "APPROVED" &&
    "bypassReason" in decision &&
    decision.bypassReason === "checker_disabled";
  if (disabledByChecker) return "not_required"; // whole checker off → CLA off too
  if (decision.status === "BYPASSED" && decision.reason === "bot") {
    return "exempt";
  }
  if (!project.claRequired) return "not_required";
  if (decision.status === "CHECK_REQUIRED" && decision.reason === "cla_stale") {
    return "stale";
  }
  if (
    decision.status === "CHECK_REQUIRED" &&
    decision.reason === "cla_required"
  ) {
    return "required";
  }
  // Decision didn't resolve the CLA (other gate, or it allows): compute
  // coverage directly so the dedicated check is accurate.
  const st = await getClaStatus({
    projectId: project.id,
    ghId: args.authorGhId,
    ghLogin: args.authorGhLogin,
  }).catch(() => null);
  return st
    ? st.satisfied
      ? "satisfied"
      : st.needsResign
        ? "stale"
        : "required"
    : "required";
}

type ProjectForSideEffects = {
  id: string;
  slug: string;
  name: string;
  checksEnabled: boolean;
  qualityEnabled: boolean;
  qualityConfig: string;
  qualityCommentMin: number;
  prTemplateHoneypots: string;
  qualityTemplateMatchPct: number;
  trackWhenDisabled: boolean;
  checkerEnabled: boolean;
};

/**
 * Publish the Check Run and run quality scoring after a decision has been
 * applied (close/comment/label already done). Both paths are best-effort;
 * a failure here must not block the webhook response.
 */
/**
 * Publish the two gate checks as success on the bot's own aggregate staging PR.
 *
 * The aggregate PR deliberately never reaches `convergePr`, which is the only
 * thing that publishes these checks. That exemption is right about the gate and
 * wrong about the checks: a maintainer who requires `contribution-checker /
 * decision` on the default branch would find the release PR permanently stuck
 * on "Expected - waiting for status to be reported". There is no PrCheck row
 * for the aggregate PR (it is not a contribution), so both calls pass a null
 * id and simply create fresh check runs on the head SHA.
 */
async function publishAggregatePrChecks(args: {
  repoId: string | null;
  repoFullName: string;
  installationId: number;
  headSha: string | null;
}): Promise<void> {
  if (!args.repoId || !args.headSha) return;
  const repo = await prisma.repo.findUnique({
    where: { id: args.repoId },
    select: {
      project: {
        select: { id: true, slug: true, name: true, checksEnabled: true },
      },
    },
  });
  if (!repo) return;
  const project = repo.project;
  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;

  await publishDecisionCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    prCheckId: null,
    headSha: args.headSha,
    project,
    decision: { status: "APPROVED", bypassReason: "staging_batch" },
    applyUrl,
    claUrl: `${applyUrl}/cla`,
  }).catch((e) =>
    logger.warn({ err: e, repoId: args.repoId }, "aggregate decision check failed"),
  );

  // The batch is the project's own merged work, not a contribution, so the CLA
  // question does not apply to it. Publishing "exempt" keeps the required
  // context green rather than leaving it absent.
  await publishClaCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    prCheckId: null,
    headSha: args.headSha,
    project: {
      id: project.id,
      name: project.name,
      checksEnabled: project.checksEnabled,
    },
    state: "exempt",
    claUrl: `${applyUrl}/cla`,
  }).catch((e) =>
    logger.warn({ err: e, repoId: args.repoId }, "aggregate CLA check failed"),
  );
}

async function postDecisionSideEffects(args: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  prCheckId: string | null;
  project: ProjectForSideEffects;
  decision: PrDecision;
  applyUrl: string;
  claUrl?: string;
  claState?: ClaCheckState | null;
}): Promise<void> {
  const { decision, project } = args;
  if (decision.status === "IGNORED") return;

  // Check Run (App-mode publishing). Skipped automatically when checks are
  // disabled or installation lacks checks:write.
  await publishDecisionCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    prCheckId: args.prCheckId,
    headSha: args.headSha,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      checksEnabled: project.checksEnabled,
    },
    decision,
    applyUrl: args.applyUrl,
    claUrl: args.claUrl,
  }).catch((e) =>
    logger.warn(
      { err: e, prCheckId: args.prCheckId },
      "publishDecisionCheck failed",
    ),
  );

  // Dedicated CLA Check Run, only when the project has CLA enabled (claState is
  // computed null otherwise). Lets maintainers require `contribution-checker /
  // cla` independently in branch protection.
  if (args.claState) {
    await publishClaCheck({
      installationId: args.installationId,
      repoFullName: args.repoFullName,
      prCheckId: args.prCheckId,
      headSha: args.headSha,
      project: {
        id: project.id,
        name: project.name,
        checksEnabled: project.checksEnabled,
      },
      state: args.claState,
      claUrl: args.claUrl,
    }).catch((e) =>
      logger.warn(
        { err: e, prCheckId: args.prCheckId },
        "publishClaCheck failed",
      ),
    );
  }

  // Quality scoring runs only when there is a tracked PrCheck row AND the
  // feature is enabled.
  if (args.prCheckId && project.qualityEnabled) {
    await runQualityForPrCheck({
      prCheckId: args.prCheckId,
      installationId: args.installationId,
      repoFullName: args.repoFullName,
      prNumber: args.prNumber,
      project,
    }).catch((e) =>
      logger.warn(
        { err: e, prCheckId: args.prCheckId },
        "runQualityForPrCheck failed",
      ),
    );
  }
}

async function ensureProjectLabels(args: {
  installationId: number;
  fullName: string;
  pending: string;
  approved: string;
  denied: string;
  evaluate: string;
}): Promise<void> {
  const ref = repoRef(args.fullName, args.installationId);
  await Promise.all([
    ensureLabel(ref, args.pending, "fbca04", "Awaiting application review"),
    ensureLabel(ref, args.approved, "0e8a16", "Approved contributor"),
    ensureLabel(ref, args.denied, "b60205", "Application denied"),
    ensureLabel(
      ref,
      args.evaluate,
      "5319e7",
      "Add to trigger a re-evaluation by the contribution checker",
    ),
  ]).catch((e) =>
    logger.warn(
      { err: e, fullName: args.fullName },
      "ensureProjectLabels failed",
    ),
  );
}

/** Result surfaced to the per-PR entity workflow (prGate): `terminal` is true
 * only when the PR has reached an end state (merged or human-closed) and the
 * workflow should complete. Every non-close event returns `terminal: false`. */
/**
 * `staging` is carried purely for observability. It is the return value of the
 * `convergePrEvent` activity, so Temporal records it in workflow history: when
 * application logs are gone or unreadable, the history still answers "did this
 * PR get retargeted, and if not, why?".
 */
export type PrEventResult = {
  terminal: boolean;
  staging?: { retargeted: boolean; outcome: StagingRoutingOutcome };
};

const NOT_TERMINAL: PrEventResult = { terminal: false };

function notTerminal(staging: StagingRoutingResult): PrEventResult {
  return {
    terminal: false,
    staging: { retargeted: staging.retargeted, outcome: staging.outcome },
  };
}

export async function handlePullRequestEvent(
  payload: WebhookPayload,
): Promise<PrEventResult> {
  const action = payload.action ?? "";
  const isReEvalLabel = action === "labeled";
  const isUnlabeled = action === "unlabeled";
  const isEdited = action === "edited";
  if (
    !payload.pull_request ||
    !payload.repository ||
    !payload.installation ||
    !(
      [
        "opened",
        "reopened",
        "ready_for_review",
        "synchronize",
        "closed",
      ].includes(action) ||
      isReEvalLabel ||
      isUnlabeled ||
      isEdited
    )
  ) {
    return NOT_TERMINAL;
  }

  // `edited` fires on every description tweak too. Three changes are
  // interesting: the base (staging routing must re-assert itself), the title
  // (the batch manifest shows titles), and the body, which carries the author's
  // own `## QA` section and the issues the PR closes. A body edit is usually
  // somebody filling that in *after* the PR merged, which is exactly when the
  // QA record needs re-deriving and the only event that says so. Everything
  // else short-circuits on the payload alone, before any DB work.
  //
  // This cannot echo the bot's own writes: the only body the bot edits is the
  // aggregate PR's, whose base is the default branch, so `touchesStaging` is
  // false for it and no reconcile is signalled.
  if (
    isEdited &&
    !payload.changes?.base &&
    !payload.changes?.title &&
    !payload.changes?.body
  ) {
    return NOT_TERMINAL;
  }

  const ghRepoId = payload.repository.id;
  const prNumber = payload.pull_request.number;
  const author = payload.pull_request.user;

  // Label events matter for exactly three labels: the project's evaluate label
  // (re-run the gate) and its two staging escape hatches, which route in both
  // directions. Added, the repoint label puts a PR the bot already retargeted
  // back where it was and the ignore label freezes it where it is; removed,
  // either releases the PR into routing again, which is what makes both
  // reversible without waiting for the PR's next push. Anything else (the
  // bot's own status labels included) must short-circuit before we touch the
  // DB or run the decision pipeline.
  //
  // The staging labels route only: they say nothing about the contributor, so
  // running the gate again on one would be work for no decision. Losing a label
  // decides nothing about the contributor either, which is why `unlabeled`
  // recognizes only those labels and never reaches the gate: the evaluate
  // label is removed by the bot itself after every re-eval, and re-gating on
  // that echo would loop.
  let stagingLabelOnly = false;
  if (isReEvalLabel || isUnlabeled) {
    const labelName = payload.label?.name;
    if (!labelName) return NOT_TERMINAL;
    const repoForLabelGate = await prisma.repo.findUnique({
      where: { ghRepoId },
      select: {
        project: {
          select: {
            labelEvaluate: true,
            labelStagingIgnore: true,
            labelStagingRepoint: true,
          },
        },
      },
    });
    if (!repoForLabelGate) return NOT_TERMINAL;
    const { labelEvaluate, labelStagingIgnore, labelStagingRepoint } =
      repoForLabelGate.project;
    if (isUnlabeled || labelEvaluate !== labelName) {
      if (labelStagingIgnore !== labelName && labelStagingRepoint !== labelName) {
        return NOT_TERMINAL;
      }
      stagingLabelOnly = true;
    }
  }

  // PR `closed`/merged is terminal for the entity model: a closed PR has nothing
  // to re-gate. A close the bot itself performed (closedByApp) is a pending/
  // denied gate that must stay reopenable, so it is NOT terminal; a human close
  // or a merge is. The per-PR entity workflow (prGate) uses this distinction to
  // complete. Here we just avoid running the decision pipeline against a closed
  // PR.
  if (action === "closed") {
    return await handlePrClosed({
      ghRepoId,
      prNumber,
      merged: payload.pull_request.merged ?? false,
      mergedAt: payload.pull_request.merged_at ?? null,
      baseRef: payload.pull_request.base?.ref ?? null,
    });
  }

  // Staging routing runs independently of the contributor gate, so a PENDING
  // PR is retargeted before it is closed and a later approval reopens it
  // already pointing at staging. Never throws; a staging failure must not stop
  // the PR from being gated.
  const staging = await runStagingRouting({
    ghRepoId,
    payload,
    authorGhLogin: author.login,
  });

  // The bot's own aggregate PR must never go through the contributor gate.
  // It has no application, so the gate would find it PENDING, close the
  // release PR and comment an apply link on it; even when bypassed it would
  // strip the batch label and quality-score a several-hundred-file diff.
  //
  // Skipping the gate must NOT skip the checks. The aggregate PR is the one PR
  // that has to merge into the default branch, so if `contribution-checker /
  // decision` and `/ cla` are required there, leaving them unpublished blocks
  // the release forever on checks that are never coming.
  if (staging.isAggregatePr) {
    logger.debug(
      { ghRepoId, prNumber },
      "skipping gate: PR is the aggregate staging PR",
    );
    await publishAggregatePrChecks({
      repoId: staging.repoId,
      repoFullName: payload.repository.full_name,
      installationId: payload.installation.id,
      headSha: payload.pull_request.head?.sha ?? null,
    });
    return notTerminal(staging);
  }

  // A title edit changes nothing the gate cares about: the batch manifest was
  // already refreshed above, so stop before the decision pipeline. The staging
  // labels are the same story: routing has had its say, and a label only a
  // maintainer can set carries no information about the contributor.
  if (isEdited || stagingLabelOnly) return notTerminal(staging);

  await convergePr({
    ghRepoId,
    repoFullName: payload.repository.full_name,
    installationId: payload.installation.id,
    prNumber,
    prNodeId: payload.pull_request.node_id,
    authorGhLogin: author.login,
    authorGhId: author.id,
    headSha: payload.pull_request.head?.sha ?? null,
    prIsClosed: payload.pull_request.state === "closed",
    isReEval: isReEvalLabel,
  });
  return notTerminal(staging);
}

/**
 * Retarget a PR to staging when the project asks for it, and tell the repo's
 * staging batch entity that its manifest may be stale. Both halves are
 * best-effort: `applyStagingRouting` and `signalStagingBatch` swallow their own
 * failures, so this never throws into the gate path.
 *
 * A reconcile is signalled whenever the PR touches staging at all, not only on
 * a retarget: a PR opened directly against staging, or retitled while on it,
 * changes the manifest just as much.
 */
const NO_STAGING_ROUTING: StagingRoutingResult = {
  repoId: null,
  retargeted: false,
  isAggregatePr: false,
  touchesStaging: false,
  outcome: "not_managed",
};

async function runStagingRouting(args: {
  ghRepoId: number;
  payload: WebhookPayload;
  authorGhLogin: string;
}): Promise<StagingRoutingResult> {
  const pr = args.payload.pull_request;
  if (!pr) return NO_STAGING_ROUTING;
  const result = await applyStagingRouting({
    ghRepoId: args.ghRepoId,
    prNumber: pr.number,
    authorGhLogin: args.authorGhLogin,
    baseRef: pr.base?.ref ?? "",
    head: {
      ref: pr.head?.ref ?? "",
      repoFullName: pr.head?.repo?.full_name ?? null,
    },
    prLabels: (pr.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string"),
    defaultBranchHint:
      pr.base?.repo?.default_branch ??
      args.payload.repository?.default_branch ??
      null,
    prIsClosed: pr.state === "closed",
  });

  if (result.repoId && (result.retargeted || result.touchesStaging)) {
    await signalStagingBatch({
      repoId: result.repoId,
      reason: result.retargeted
        ? "pr_retargeted"
        : `pr_${args.payload.action ?? "event"}`,
    });
  }
  return result;
}

/**
 * Distinguish a terminal PR close (human close or merge) from the bot's own
 * pending/denied close (`closedByApp`, which must stay reopenable). A terminal
 * close lets prGate complete; the bot's own close keeps the entity alive so the
 * PR can be reopened on a later approval/re-gate.
 *
 * A close also feeds staging routing: the aggregate PR closing ends the batch,
 * and any other PR on staging closing changes the manifest.
 */
async function handlePrClosed(args: {
  ghRepoId: number;
  prNumber: number;
  merged: boolean;
  mergedAt?: string | null;
  baseRef?: string | null;
}): Promise<PrEventResult> {
  const repo = await prisma.repo.findUnique({
    where: { ghRepoId: args.ghRepoId },
    select: {
      id: true,
      ...stagingRepoSelect,
      project: { select: stagingProjectSelect },
    },
  });
  if (!repo) return NOT_TERMINAL;
  const stagingCfg = resolveStagingConfig(repo.project, repo);

  try {
    const wasAggregate = await handleAggregatePrClosed({
      repoId: repo.id,
      prNumber: args.prNumber,
      merged: args.merged,
      mergedAt: args.mergedAt ? new Date(args.mergedAt) : null,
    });
    // Deliberately no reconcile when the aggregate PR itself closed. If it
    // merged, staging is no longer ahead and there is nothing to open; if a
    // human closed it unmerged, immediately reopening one would override them.
    // Either way the next staging activity starts a fresh batch.
    if (!wasAggregate && args.baseRef === stagingCfg.stagingBranch) {
      await signalStagingBatch({
        repoId: repo.id,
        reason: args.merged ? "pr_merged_to_staging" : "pr_closed_on_staging",
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, ghRepoId: args.ghRepoId, prNumber: args.prNumber },
      "staging batch update on PR close failed",
    );
  }

  const prCheck = await prisma.prCheck.findUnique({
    where: { repoId_prNumber: { repoId: repo.id, prNumber: args.prNumber } },
    select: { closedByApp: true },
  });
  // Our own gate-close: not terminal, keep it reopenable.
  if (prCheck?.closedByApp) return NOT_TERMINAL;
  logger.debug(
    { ghRepoId: args.ghRepoId, prNumber: args.prNumber, merged: args.merged },
    "PR terminally closed",
  );
  return { terminal: true };
}

/**
 * Re-evaluate a single open PR on demand (no webhook payload): fetch its current
 * state from GitHub, then converge with re-evaluation semantics (reopen a
 * now-passing closedByApp PR). This is the `reGate` apply path the per-PR entity
 * workflow (prGate) runs when a parent gate signals "re-evaluate". Best-effort:
 * a fetch failure logs and no-ops so a transient API error never wedges the gate.
 */
export async function reGatePr(args: {
  ghRepoId: number;
  prNumber: number;
}): Promise<void> {
  const repo = await prisma.repo.findUnique({
    where: { ghRepoId: args.ghRepoId },
    select: { fullName: true, installationId: true },
  });
  if (!repo || repo.installationId == null) return;
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) return;
  let pr: {
    node_id: string;
    state: string;
    user: { login: string; id: number } | null;
    head?: { sha: string; ref?: string; repo?: { full_name?: string } | null };
    base?: { ref?: string; repo?: { default_branch?: string } };
    labels?: Array<{ name?: string }>;
  };
  try {
    const octokit = await getInstallationOctokit(repo.installationId);
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo: name, pull_number: args.prNumber },
    );
    pr = res.data as typeof pr;
  } catch (e) {
    logger.warn(
      { err: e, ghRepoId: args.ghRepoId, prNumber: args.prNumber },
      "reGatePr: PR fetch failed",
    );
    return;
  }
  if (!pr.user) return;
  // A re-gate is also how the settings toggle reaches existing open PRs, so
  // staging routing must re-assert itself here too.
  const staging = await runStagingRouting({
    ghRepoId: args.ghRepoId,
    payload: {
      action: "regate",
      pull_request: { ...pr, number: args.prNumber },
    } as WebhookPayload,
    authorGhLogin: pr.user.login,
  });
  if (staging.isAggregatePr) return;
  await convergePr({
    ghRepoId: args.ghRepoId,
    repoFullName: repo.fullName,
    installationId: repo.installationId,
    prNumber: args.prNumber,
    prNodeId: pr.node_id,
    authorGhLogin: pr.user.login,
    authorGhId: pr.user.id,
    headSha: pr.head?.sha ?? null,
    prIsClosed: pr.state === "closed",
    isReEval: true,
  });
}

/**
 * Idempotently converge a single PR to its current decision: decide → upsert the
 * PrCheck row → apply GitHub side effects (close/reopen, labels, comment, Check
 * Run, quality). Driven today by the webhook (one call per pull_request event);
 * the per-PR entity workflow (prGate) calls this through an activity to
 * re-evaluate on demand. Every step is idempotent, so repeat calls are no-ops.
 */
export async function convergePr(ctx: {
  ghRepoId: number;
  repoFullName: string;
  installationId: number;
  prNumber: number;
  prNodeId: string;
  authorGhLogin: string;
  authorGhId: number;
  headSha: string | null;
  prIsClosed: boolean;
  /** Honor the re-evaluation semantics: reopen a now-passing closedByApp PR,
   * strip the evaluate trigger label, and don't re-close an already-closed PR. */
  isReEval: boolean;
}): Promise<void> {
  const {
    ghRepoId,
    repoFullName,
    installationId,
    prNumber,
    prNodeId,
    headSha,
    prIsClosed,
  } = ctx;
  const author = { login: ctx.authorGhLogin, id: ctx.authorGhId };
  const isReEvalLabel = ctx.isReEval;

  // The pipeline result. DCO is layered on later (it needs the PR's commits,
  // which the decision path doesn't load), so this is a mutable working copy.
  let decision = await decideForPR({
    ghRepoId,
    prAuthorGhLogin: author.login,
    prAuthorGhId: author.id,
  });

  const decisionAttrs: Record<string, string> = {
    "decision.outcome": decision.status,
  };
  if ("reason" in decision && decision.reason) {
    decisionAttrs["decision.reason"] = String(decision.reason);
  }
  if ("bypassReason" in decision && decision.bypassReason) {
    decisionAttrs["decision.bypass_reason"] = decision.bypassReason;
  }
  if (decision.projectId) decisionAttrs["project.id"] = decision.projectId;
  Sentry.getCurrentScope().setAttributes(decisionAttrs);
  Sentry.metrics.count("pr.decision", 1, {
    attributes: {
      ...decisionAttrs,
      mode: "app",
    },
  });

  if (decision.status === "IGNORED") {
    logger.debug({ ghRepoId, prNumber, reason: decision.reason }, "PR ignored");
    return;
  }

  // Look up project for label config + apply URL
  const project = decision.projectId
    ? await prisma.project.findUnique({
        where: { id: decision.projectId },
        select: {
          id: true,
          slug: true,
          name: true,
          labelsEnabled: true,
          labelPending: true,
          labelApproved: true,
          labelDenied: true,
          labelEvaluate: true,
          labelClaPending: true,
          claEnabled: true,
          claRequired: true,
          dcoEnabled: true,
          checkerEnabled: true,
          trackWhenDisabled: true,
          checksEnabled: true,
          qualityEnabled: true,
          qualityConfig: true,
          qualityCommentMin: true,
          prTemplateHoneypots: true,
          qualityTemplateMatchPct: true,
        },
      })
    : null;
  if (!project) return;

  // DCO layer (see applyDcoGate): may override an allowing decision to
  // CHECK_REQUIRED{dco_missing}. Needs the PR's commits, so it runs here rather
  // than in the decision pipeline.
  decision = await applyDcoGate({
    decision,
    dcoEnabled: project.dcoEnabled,
    installationId,
    repoFullName,
    prNumber,
  });

  const disabledByChecker =
    decision.status === "APPROVED" &&
    decision.bypassReason === "checker_disabled";

  // Dedicated CLA-check state (independent of the overall decision), so the
  // `contribution-checker / cla` check accurately reflects the author's CLA
  // coverage even on paths where the decision short-circuited before the CLA
  // layer (manual/application DENIED, no-application PENDING, etc.).
  const claState = await resolveClaState({
    project,
    decision,
    authorGhId: author.id,
    authorGhLogin: author.login,
  });

  // CHECK_REQUIRED is an active CLA/DCO gate, so it must always create a
  // PrCheck row (the re-check/sweep machinery finds affected PRs by
  // gateReason) regardless of trackWhenDisabled.
  const shouldTrackPr =
    decision.status === "CHECK_REQUIRED" ||
    !disabledByChecker ||
    project.trackWhenDisabled;
  let prCheckId: string | null = null;

  // Persist PrCheck (skipped when checker is disabled and tracking is off)
  const prCheckStatus =
    decision.status === "APPROVED" || decision.status === "BYPASSED"
      ? "APPROVED"
      : decision.status === "DENIED"
        ? "DENIED"
        : decision.status === "CHECK_REQUIRED"
          ? "CHECK_REQUIRED"
          : "PENDING";
  // gateReason is only meaningful for CHECK_REQUIRED; cleared (null) otherwise
  // so a PR that later clears the gate doesn't retain a stale reason.
  const gateReason =
    decision.status === "CHECK_REQUIRED" ? decision.reason : null;
  // Comment idempotency for the keep-open CLA/DCO gate: if the prior PrCheck
  // row was already CHECK_REQUIRED with the same gateReason we've posted the
  // comment before, so skip re-posting. Read BEFORE the upsert overwrites it.
  let alreadyGated = false;
  if (decision.repoId && shouldTrackPr) {
    const prior = await prisma.prCheck.findUnique({
      where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
      select: { status: true, gateReason: true, headSha: true },
    });
    alreadyGated =
      prior?.status === "CHECK_REQUIRED" && prior.gateReason === gateReason;
    // New commits (synchronize) advance the head SHA. The stored check-run ids
    // belong to the previous SHA and can't be moved (GitHub's check-run update
    // ignores head_sha), so clear them: both publishers must create fresh runs
    // on the new SHA. Without this they'd PATCH the old runs and leave the
    // required contexts "Expected — Waiting for status to be reported".
    const shaAdvanced =
      !!headSha && prior?.headSha != null && prior.headSha !== headSha;
    const prCheck = await prisma.prCheck.upsert({
      where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
      update: {
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status: prCheckStatus,
        gateReason,
        ...(headSha ? { headSha } : {}),
        ...(shaAdvanced ? { checkRunId: null, claCheckRunId: null } : {}),
      },
      create: {
        repoId: decision.repoId,
        prNumber,
        prNodeId,
        authorGhLogin: author.login,
        authorGhId: author.id,
        status: prCheckStatus,
        gateReason,
        closedByApp: false,
        headSha,
      },
    });
    prCheckId = prCheck.id;
  }

  const ref = repoRef(repoFullName, installationId);
  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;
  const claUrl = `${applyUrl}/cla`;

  if (project.labelsEnabled) {
    await ensureProjectLabels({
      installationId,
      fullName: repoFullName,
      pending: project.labelPending,
      approved: project.labelApproved,
      denied: project.labelDenied,
      evaluate: project.labelEvaluate,
    });
  }

  // Always strip the evaluate trigger label after a re-eval, regardless of
  // labelsEnabled. The admin added it to fire this run; leaving it on would
  // re-trigger on every subsequent webhook touch.
  const removeEvaluateLabel = async () => {
    if (!isReEvalLabel) return;
    await removeLabelIfPresent(ref, prNumber, project.labelEvaluate).catch(
      () => undefined,
    );
  };

  if (decision.status === "APPROVED" || decision.status === "BYPASSED") {
    // Re-eval on a previously closed-by-app PR: reopen it so the now-passing
    // decision has somewhere to land.
    if (isReEvalLabel && prIsClosed && decision.repoId) {
      const existing = await prisma.prCheck.findUnique({
        where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
        select: { closedByApp: true },
      });
      if (existing?.closedByApp) {
        try {
          await reopenPullRequest(
            ref,
            prNumber,
            `Re-evaluation by **${project.name}** passed. Reopening this PR.`,
          );
          await prisma.prCheck.update({
            where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
            data: { closedByApp: false },
          });
        } catch (e) {
          logger.warn(
            { err: e, repoFullName, prNumber },
            "re-eval reopen failed",
          );
        }
      }
    }
    if (project.labelsEnabled) {
      await Promise.all([
        removeLabelIfPresent(ref, prNumber, project.labelPending).catch(
          () => undefined,
        ),
        removeLabelIfPresent(ref, prNumber, project.labelDenied).catch(
          () => undefined,
        ),
        removeLabelIfPresent(ref, prNumber, project.labelClaPending).catch(
          () => undefined,
        ),
        setLabels(ref, prNumber, [project.labelApproved]).catch(
          () => undefined,
        ),
      ]);
    }
    await removeEvaluateLabel();
    await postDecisionSideEffects({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      prCheckId,
      project,
      decision,
      applyUrl,
      claUrl,
      claState,
    });
    return;
  }

  // CHECK_REQUIRED (CLA/DCO) → keep the PR OPEN, fail the Check. This is
  // deliberately separate from the PENDING/DENIED close path below: CLA/DCO
  // gates never close the PR.
  if (decision.status === "CHECK_REQUIRED") {
    try {
      // Idempotent comment: only post when we haven't already gated this PR
      // for the same reason (alreadyGated derived from the prior PrCheck row).
      if (!alreadyGated) {
        const body = buildDecisionMessage({
          decision,
          projectName: project.name,
          applyUrl,
          ghLogin: author.login,
          claUrl,
          infoUrl: contributorInfoUrl(),
        });
        if (body) {
          await commentOnPr(ref, prNumber, body).catch((e) =>
            logger.warn(
              { err: e, repoFullName, prNumber },
              "CLA/DCO gate comment failed",
            ),
          );
        }
      }
      // Labels: drop the application-status labels, add the cla-pending label.
      if (project.labelsEnabled) {
        // labelClaPending isn't part of ensureProjectLabels above; ensure it
        // exists like the approved/pending/denied labels before applying.
        await ensureLabel(
          ref,
          project.labelClaPending,
          "fbca04",
          "Awaiting CLA signature / DCO sign-off",
        ).catch(() => undefined);
        await Promise.all([
          removeLabelIfPresent(ref, prNumber, project.labelApproved).catch(
            () => undefined,
          ),
          removeLabelIfPresent(ref, prNumber, project.labelPending).catch(
            () => undefined,
          ),
          removeLabelIfPresent(ref, prNumber, project.labelDenied).catch(
            () => undefined,
          ),
        ]);
        await setLabels(ref, prNumber, [project.labelClaPending]).catch(
          () => undefined,
        );
      }
    } catch (e) {
      logger.warn(
        { err: e, repoFullName, prNumber },
        "CLA/DCO gate side-effects failed",
      );
    }

    await removeEvaluateLabel();

    // Publish the failing/action_required Check Run (no close, no pr.blocked
    // webhook). The PrCheck row was already upserted above with status
    // CHECK_REQUIRED + gateReason.
    await postDecisionSideEffects({
      installationId,
      repoFullName,
      prNumber,
      headSha,
      prCheckId,
      project,
      decision,
      applyUrl,
      claUrl,
      claState,
    });
    return;
  }

  // PENDING or DENIED → close + comment + label
  const body =
    buildDecisionMessage({
      decision,
      projectName: project.name,
      applyUrl,
      ghLogin: author.login,
      // A pending applicant is blocked on review; if the project also requires a
      // CLA they haven't signed, surface it on the PR now so they can sign in
      // parallel (claState is "required"/"stale" exactly when uncovered/stale).
      needsCla: claState === "required" || claState === "stale",
      infoUrl: contributorInfoUrl(),
    }) ?? "";

  try {
    // Skip the close+comment when the PR is already closed (the only path
    // that gets here closed is a re-eval label add). Re-closing would post a
    // duplicate decision comment on every label re-trigger.
    if (!prIsClosed) {
      await closePullRequest(ref, prNumber, body);
      if (decision.repoId && shouldTrackPr) {
        await prisma.prCheck.update({
          where: { repoId_prNumber: { repoId: decision.repoId, prNumber } },
          data: { closedByApp: true },
        });
      }
      await enqueueProjectWebhook({
        projectId: project.id,
        event: "pr.blocked",
        payload: {
          repo: repoFullName,
          prNumber,
          ghLogin: author.login,
          reason: decision.status === "PENDING" ? "no-application" : "denied",
        },
      });
    }
    if (project.labelsEnabled) {
      const targetLabel =
        decision.status === "PENDING"
          ? project.labelPending
          : project.labelDenied;
      const otherLabels = [
        project.labelApproved,
        project.labelClaPending,
        decision.status === "PENDING"
          ? project.labelDenied
          : project.labelPending,
      ];
      await Promise.all(
        otherLabels.map((l) =>
          removeLabelIfPresent(ref, prNumber, l).catch(() => undefined),
        ),
      );
      await setLabels(ref, prNumber, [targetLabel]).catch(() => undefined);
    }
  } catch (e) {
    logger.error({ err: e, repoFullName, prNumber }, "PR close/label failed");
  }

  await removeEvaluateLabel();

  await postDecisionSideEffects({
    installationId,
    repoFullName,
    prNumber,
    headSha,
    prCheckId,
    project,
    decision,
    applyUrl,
    claUrl,
    claState,
  });
}

type MergeGroupPayload = {
  action?: string;
  installation?: { id: number };
  repository?: { id: number; full_name: string };
  merge_group?: {
    head_sha?: string;
    head_ref?: string;
    base_sha?: string;
    base_ref?: string;
  };
};

/**
 * Extract the PR number(s) encoded in a merge-queue branch ref. GitHub names
 * the temporary branch `refs/heads/gh-readonly-queue/<base>/pr-<number>-<sha>`;
 * a batched group can carry several `pr-<number>-` segments. Returns them in
 * ref order, de-duplicated.
 */
export function parsePrNumbersFromMergeRef(ref: string): number[] {
  const seen = new Set<number>();
  for (const m of ref.matchAll(/\/pr-(\d+)-/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n)) seen.add(n);
  }
  return [...seen];
}

/**
 * GitHub `merge_group` event (merge queue). When a PR enters the queue GitHub
 * builds a temporary `gh-readonly-queue/...` branch with a fresh head commit and
 * asks (action `checks_requested`) for required checks to be reported against
 * THAT commit. The pull_request-driven checks only ever land on the PR head SHA,
 * so without this handler the queue waits forever ("Expected — Waiting for
 * status to be reported"). Here we re-evaluate each PR in the group and
 * republish both check runs on the merge-group head SHA.
 *
 * Deliberately NO PR side effects (no close/label/comment, no PrCheck row): the
 * merge-group SHA is transient. We pass prCheckId: null so the publishers create
 * standalone check runs and never overwrite the PR's stored check-run ids. When
 * a group batches multiple PRs we publish the most-blocking conclusion, since
 * the queue must not merge if any member is gated.
 */
export async function handleMergeGroupEvent(payload: MergeGroupPayload) {
  // "checks_requested" asks us to report; "destroyed" needs no action.
  if (payload.action !== "checks_requested") return;
  const headSha = payload.merge_group?.head_sha;
  if (!headSha || !payload.repository || !payload.installation) return;

  const installationId = payload.installation.id;
  const repoFullName = payload.repository.full_name;
  const ghRepoId = payload.repository.id;

  const prNumbers = parsePrNumbersFromMergeRef(
    payload.merge_group?.head_ref ?? "",
  );
  if (prNumbers.length === 0) {
    logger.warn(
      { repoFullName, headRef: payload.merge_group?.head_ref },
      "merge_group: no PR number found in ref; cannot publish checks",
    );
    return;
  }

  const repo = await prisma.repo.findUnique({
    where: { ghRepoId },
    include: decisionRepoInclude,
  });
  if (!repo) return;
  const project = await prisma.project.findUnique({
    where: { id: repo.projectId },
    select: {
      id: true,
      slug: true,
      name: true,
      checksEnabled: true,
      claEnabled: true,
      claRequired: true,
      dcoEnabled: true,
    },
  });
  if (!project) return;
  // Checks disabled → the publishers would no-op anyway; skip the eval work.
  if (!project.checksEnabled) return;

  const applyUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${project.slug}`;
  const claUrl = `${applyUrl}/cla`;

  const evaluations: Array<{
    decision: PrDecision & { repoId?: string; projectId?: string };
    claState: ClaCheckState | null;
  }> = [];
  for (const prNumber of prNumbers) {
    // Author comes from the stored PrCheck row when the PR already went through
    // the pull_request path; fall back to the GitHub API otherwise.
    const prior = await prisma.prCheck.findUnique({
      where: { repoId_prNumber: { repoId: repo.id, prNumber } },
      select: { authorGhLogin: true, authorGhId: true },
    });
    let login = prior?.authorGhLogin ?? null;
    let id = prior?.authorGhId ?? null;
    if (login == null || id == null) {
      try {
        const octokit = await getInstallationOctokit(installationId);
        const [owner, name] = repoFullName.split("/");
        if (owner && name) {
          const res = await octokit.request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            { owner, repo: name, pull_number: prNumber },
          );
          login = res.data.user?.login ?? null;
          id = res.data.user?.id ?? null;
        }
      } catch (e) {
        logger.warn(
          { err: e, repoFullName, prNumber },
          "merge_group: failed to fetch PR author",
        );
      }
    }
    if (login == null || id == null) continue;

    let decision = await decideForRepo({
      repo,
      prAuthorGhLogin: login,
      prAuthorGhId: id,
    });
    if (decision.status === "IGNORED") continue;
    decision = await applyDcoGate({
      decision,
      dcoEnabled: project.dcoEnabled,
      installationId,
      repoFullName,
      prNumber,
    });
    const claState = await resolveClaState({
      project,
      decision,
      authorGhId: id,
      authorGhLogin: login,
    });
    evaluations.push({ decision, claState });
  }
  if (evaluations.length === 0) return;

  // Most-blocking wins: any non-allowing decision (or required/stale CLA) gates
  // the whole group. Decision and CLA picks may come from different members.
  const blocking = evaluations.find(
    (e) =>
      e.decision.status !== "APPROVED" && e.decision.status !== "BYPASSED",
  );
  const chosenDecision = (blocking ?? evaluations[0]).decision;
  if (chosenDecision.status === "IGNORED") return;
  const claBlocking = evaluations.find(
    (e) => e.claState === "required" || e.claState === "stale",
  );
  const chosenCla = claBlocking?.claState ?? evaluations[0].claState;

  await publishDecisionCheck({
    installationId,
    repoFullName,
    prCheckId: null,
    headSha,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      checksEnabled: project.checksEnabled,
    },
    decision: chosenDecision,
    applyUrl,
    claUrl,
  }).catch((e) =>
    logger.warn({ err: e, repoFullName }, "merge_group decision check failed"),
  );

  if (chosenCla) {
    await publishClaCheck({
      installationId,
      repoFullName,
      prCheckId: null,
      headSha,
      project: {
        id: project.id,
        name: project.name,
        checksEnabled: project.checksEnabled,
      },
      state: chosenCla,
      claUrl,
    }).catch((e) =>
      logger.warn({ err: e, repoFullName }, "merge_group cla check failed"),
    );
  }
}

export async function handleInstallationEvent(payload: WebhookPayload) {
  if (!payload.installation) return;
  const installationId = payload.installation.id;

  // Initial install (and re-activations) carry the repo list inline in the
  // `repositories` field; no separate `installation_repositories` event is
  // fired for the first batch. Link those to any manually-entered rows so the
  // PR webhook can find them by ghRepoId.
  if (
    (payload.action === "created" ||
      payload.action === "new_permissions_accepted" ||
      payload.action === "unsuspend") &&
    payload.repositories
  ) {
    await attachInstallationToManualRepos({
      installationId,
      repos: payload.repositories,
    });
    return;
  }

  // Detach repos from the installation when the App is uninstalled or
  // suspended. The Repo row stays so the project still lists the repo; it
  // just falls back to the "App not installed" state and can be re-linked.
  if (payload.action === "deleted" || payload.action === "suspend") {
    await prisma.repo.updateMany({
      where: { installationId },
      data: { installationId: null, ghRepoId: null },
    });
  }
}

export async function handleInstallationReposEvent(payload: WebhookPayload) {
  // When repos are removed from an installation, deactivate them
  if (
    payload.action === "removed" &&
    payload.repositories_removed &&
    payload.installation
  ) {
    const ghRepoIds = payload.repositories_removed.map((r) => r.id);
    if (ghRepoIds.length === 0) return;
    await prisma.repo.updateMany({
      where: {
        ghRepoId: { in: ghRepoIds },
        installationId: payload.installation.id,
      },
      data: { installationId: null, ghRepoId: null },
    });
  }
  // When repos are added to an installation, attach App metadata to any
  // manually-entered Repo rows whose fullName matches.
  if (
    payload.action === "added" &&
    payload.repositories_added &&
    payload.installation
  ) {
    await attachInstallationToManualRepos({
      installationId: payload.installation.id,
      repos: payload.repositories_added,
    });
  }
}

type PushPayload = {
  ref?: string;
  repository?: { id: number; default_branch?: string };
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  head_commit?: {
    added?: string[];
    modified?: string[];
    removed?: string[];
  } | null;
};

/**
 * GitHub `push` event. Auto-track + auto-version: when the file backing a
 * project's repo-file-sourced CLA changes on its branch, publish a new CLA
 * version (see syncRepoFileClaForPush). Best-effort; never throws so the
 * delivery is never retried for a CLA-sync failure.
 */
export async function handlePushEvent(payload: PushPayload) {
  try {
    const ghRepoId = payload.repository?.id;
    const ref = payload.ref ?? "";
    if (!ghRepoId || !ref.startsWith("refs/heads/")) return;
    const branch = ref.slice("refs/heads/".length);
    const defaultBranch = payload.repository?.default_branch ?? branch;

    // Collect the paths the push touched (added/modified) from the commit list
    // and head_commit. GitHub truncates very large pushes; when we have no
    // commit data at all, pass null to force a re-fetch rather than miss a edit.
    const changed = new Set<string>();
    const commits = payload.commits ?? [];
    for (const c of commits) {
      (c.added ?? []).forEach((p) => changed.add(p));
      (c.modified ?? []).forEach((p) => changed.add(p));
    }
    if (payload.head_commit) {
      (payload.head_commit.added ?? []).forEach((p) => changed.add(p));
      (payload.head_commit.modified ?? []).forEach((p) => changed.add(p));
    }
    const changedPaths =
      commits.length === 0 && !payload.head_commit ? null : changed;

    await syncRepoFileClaForPush({
      ghRepoId,
      branch,
      defaultBranch,
      changedPaths,
    });

    // Commits can reach staging without a PR. Refresh the batch so the
    // aggregate PR exists (and its manifest is current) either way.
    const repo = await prisma.repo.findUnique({
      where: { ghRepoId },
      select: {
        id: true,
        defaultBranch: true,
        ...stagingRepoSelect,
        project: { select: stagingProjectSelect },
      },
    });
    if (!repo) return;
    const cfg = resolveStagingConfig(repo.project, repo);
    if (payload.repository?.default_branch &&
        repo.defaultBranch !== payload.repository.default_branch) {
      await prisma.repo.update({
        where: { id: repo.id },
        data: { defaultBranch: payload.repository.default_branch },
      });
    }
    // A push to staging changes the batch. A push to the DEFAULT branch is
    // what leaves staging behind, and is the only trigger for syncing it back
    // up: without this, a repo whose default branch keeps moving while nothing
    // merges into staging would never sync at all.
    const onStaging = branch === cfg.stagingBranch;
    const onDefault = branch === defaultBranch && branch !== cfg.stagingBranch;
    if (cfg.anyEnabled && (onStaging || onDefault)) {
      await signalStagingBatch({
        repoId: repo.id,
        reason: onStaging ? "push_to_staging" : "push_to_default",
      });
    }
  } catch (e) {
    logger.warn({ err: e }, "handlePushEvent failed");
  }
}
