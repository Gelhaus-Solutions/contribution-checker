import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  upsertCheckRun,
  findCheckRunIdByName,
  installationHasChecksWrite,
  repoRef,
  type CheckRunStatus,
  type CheckRunConclusion,
} from "@/lib/github/pr-actions";
import type { PrDecision } from "@/lib/applications/decide-pr";
import {
  buildQaCheckPayload,
  buildQaNotApplicablePayload,
  type QaCheckPayload,
  type QaNotApplicableReason,
  type QaRenderItem,
} from "@/lib/qa/render";

export const CHECK_RUN_NAME = "contribution-checker / decision";
// A second, independent Check Run dedicated to the CLA gate so maintainers can
// require CLA as its own status check in branch protection, separate from the
// overall decision check.
export const CLA_CHECK_RUN_NAME = "contribution-checker / cla";

type DecisionFor = Extract<
  PrDecision,
  { status: "APPROVED" | "BYPASSED" | "PENDING" | "CHECK_REQUIRED" | "DENIED" }
>;

type ProjectInfo = {
  id: string;
  slug: string;
  name: string;
  checksEnabled: boolean;
};

export type DecisionCheckPayload = {
  name: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
};

/**
 * Map a decision into Check Run state. Pure, no I/O; used by both the
 * App-mode publisher and the CI mode endpoint to return identical payloads.
 */
export function buildDecisionCheckPayload(args: {
  decision: DecisionFor;
  applyUrl: string;
  projectName: string;
  /** Signing page URL; used as detailsUrl for CLA gates. Falls back to applyUrl. */
  claUrl?: string;
}): DecisionCheckPayload {
  const { decision, applyUrl, projectName, claUrl } = args;
  switch (decision.status) {
    case "APPROVED": {
      const bypassReason =
        "bypassReason" in decision ? decision.bypassReason : undefined;
      if (bypassReason === "staging_batch") {
        return {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "success",
          title: "Staging batch",
          summary: `Aggregate staging release PR for ${projectName}. The contributor gate does not apply to it.`,
          detailsUrl: applyUrl,
        };
      }
      const disabled = bypassReason === "checker_disabled";
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "success",
        title: disabled ? "Checker disabled" : "Approved",
        summary: disabled
          ? `Contribution checker is currently disabled for ${projectName}; PR auto-approved.`
          : `Approved contributor for ${projectName}.`,
        detailsUrl: applyUrl,
      };
    }
    case "BYPASSED":
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "success",
        title: `Bypassed (${decision.reason})`,
        summary:
          decision.reason === "bot"
            ? "PR author matches the project's bot bypass list."
            : "PR author is a repo collaborator and is bypassed.",
        detailsUrl: applyUrl,
      };
    case "PENDING": {
      if (decision.reason === "submitted") {
        return {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "action_required",
          title: "Application under review",
          summary: `Your application for ${projectName} is awaiting reviewer action.`,
          detailsUrl: applyUrl,
        };
      }
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "action_required",
        title: "Application required",
        summary: `Open an application for ${projectName} to unblock this PR.`,
        detailsUrl: applyUrl,
      };
    }
    case "CHECK_REQUIRED": {
      if (decision.reason === "dco_missing") {
        return {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "action_required",
          title: "DCO sign-off required",
          summary: `One or more commits are missing a Developer Certificate of Origin sign-off. Add a "Signed-off-by" trailer to each commit (e.g. \`git commit -s\`). Your PR stays open and we'll re-check automatically.`,
          detailsUrl: applyUrl,
        };
      }
      const stale = decision.reason === "cla_stale";
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "action_required",
        title: "CLA required",
        summary: stale
          ? `A new version of the ${projectName} CLA must be signed. Sign it to unblock this PR. Your PR stays open and we'll re-check automatically once signed.`
          : `Sign the ${projectName} CLA to unblock this PR. Your PR stays open and we'll re-check automatically once signed.`,
        detailsUrl: claUrl ?? applyUrl,
      };
    }
    case "DENIED": {
      // The denial reason is confidential (admin/dashboard only); never put it
      // in the Check Run summary, which is publicly visible on the PR.
      const cooldownText = decision.cooldownUntil
        ? `Denied until ${decision.cooldownUntil.toISOString().slice(0, 10)}.`
        : "Denied.";
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "failure",
        title: cooldownText,
        summary: cooldownText,
        detailsUrl: applyUrl,
      };
    }
  }
}

/**
 * Publish a Check Run reflecting the PR decision. Idempotent: when a
 * `PrCheck.checkRunId` is already stored, updates that run instead of
 * creating a new one. Silently no-ops when:
 *   - project.checksEnabled is false
 *   - installation lacks checks:write (feature-detect)
 *   - no headSha is available
 */
export async function publishDecisionCheck(args: {
  installationId: number;
  repoFullName: string;
  prCheckId: string | null;
  headSha: string | null;
  project: ProjectInfo;
  decision: DecisionFor;
  applyUrl: string;
  claUrl?: string;
}): Promise<void> {
  if (!args.project.checksEnabled) return;
  if (!args.headSha) return;
  if (!(await installationHasChecksWrite(args.installationId))) return;

  const payload = buildDecisionCheckPayload({
    decision: args.decision,
    applyUrl: args.applyUrl,
    projectName: args.project.name,
    claUrl: args.claUrl,
  });

  let existingId: string | null = null;
  if (args.prCheckId) {
    const row = await prisma.prCheck.findUnique({
      where: { id: args.prCheckId },
      select: { checkRunId: true, headSha: true },
    });
    // Reuse the existing check run only if it's for the same SHA.
    if (row?.checkRunId && row.headSha === args.headSha) {
      existingId = row.checkRunId;
    }
  }

  const ref = repoRef(args.repoFullName, args.installationId);
  try {
    const newId = await upsertCheckRun(
      ref,
      {
        headSha: args.headSha,
        name: payload.name,
        status: payload.status,
        conclusion: payload.conclusion,
        title: payload.title,
        summary: payload.summary,
        detailsUrl: payload.detailsUrl,
      },
      existingId,
    );
    if (newId && args.prCheckId) {
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: { checkRunId: newId, headSha: args.headSha },
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, prCheckId: args.prCheckId },
      "publishDecisionCheck failed",
    );
  }
}

// ===== Dedicated CLA Check Run =====

/**
 * The state the standalone `contribution-checker / cla` check reports. It
 * reflects the PR author's CLA coverage directly (not the overall decision), so
 * it can be required in branch protection on its own:
 *   - satisfied/exempt/not_required → success (mergeable w.r.t. CLA)
 *   - required/stale               → action_required (must sign / re-sign)
 */
export type ClaCheckState =
  | "satisfied"
  | "required"
  | "stale"
  | "exempt"
  | "not_required";

/** Pure mapping of a CLA-check state to a Check Run payload. */
export function buildClaCheckPayload(args: {
  state: ClaCheckState;
  projectName: string;
  claUrl?: string;
}): DecisionCheckPayload {
  const { state, projectName, claUrl } = args;
  const base = { name: CLA_CHECK_RUN_NAME, status: "completed" as const };
  switch (state) {
    case "required":
      return {
        ...base,
        conclusion: "action_required",
        title: "CLA required",
        summary: `Sign the Contributor License Agreement for ${projectName} before this PR can be merged.`,
        detailsUrl: claUrl,
      };
    case "stale":
      return {
        ...base,
        conclusion: "action_required",
        title: "Re-sign the CLA",
        summary: `The CLA for ${projectName} was updated; re-sign the current version before merging.`,
        detailsUrl: claUrl,
      };
    case "exempt":
      return {
        ...base,
        conclusion: "success",
        title: "CLA exempt",
        summary: "The author is exempt from the CLA (matches the bypass list).",
      };
    case "not_required":
      return {
        ...base,
        conclusion: "success",
        title: "CLA not required",
        summary: `No CLA signature is required for ${projectName}.`,
      };
    case "satisfied":
    default:
      return {
        ...base,
        conclusion: "success",
        title: "CLA signed",
        summary: `The Contributor License Agreement for ${projectName} is on file.`,
        detailsUrl: claUrl,
      };
  }
}

/**
 * Publish the dedicated CLA Check Run. Mirrors publishDecisionCheck but uses a
 * separate stored id (`PrCheck.claCheckRunId`) so the two checks coexist. Same
 * guards: no-op when checks are disabled, no headSha, or the installation lacks
 * `checks:write`.
 */
export async function publishClaCheck(args: {
  installationId: number;
  repoFullName: string;
  prCheckId: string | null;
  headSha: string | null;
  project: { id: string; name: string; checksEnabled: boolean };
  state: ClaCheckState;
  claUrl?: string;
}): Promise<void> {
  if (!args.project.checksEnabled) return;
  if (!args.headSha) return;
  if (!(await installationHasChecksWrite(args.installationId))) return;

  const payload = buildClaCheckPayload({
    state: args.state,
    projectName: args.project.name,
    claUrl: args.claUrl,
  });

  let existingId: string | null = null;
  if (args.prCheckId) {
    const row = await prisma.prCheck.findUnique({
      where: { id: args.prCheckId },
      select: { claCheckRunId: true, headSha: true },
    });
    if (row?.claCheckRunId && row.headSha === args.headSha) {
      existingId = row.claCheckRunId;
    }
  }

  const ref = repoRef(args.repoFullName, args.installationId);
  try {
    const newId = await upsertCheckRun(
      ref,
      {
        headSha: args.headSha,
        name: payload.name,
        status: payload.status,
        conclusion: payload.conclusion,
        title: payload.title,
        summary: payload.summary,
        detailsUrl: payload.detailsUrl,
      },
      existingId,
    );
    if (newId && args.prCheckId) {
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: { claCheckRunId: newId, headSha: args.headSha },
      });
    }
  } catch (e) {
    logger.warn(
      { err: e, prCheckId: args.prCheckId },
      "publishClaCheck failed",
    );
  }
}

// ===== Dedicated QA Check Run =====

/**
 * A third independent check reporting whether the staging batch has actually
 * been verified, so a maintainer can require it in branch protection on the
 * default branch and stop a release nobody has tested.
 *
 * Published only on the aggregate PR. Ordinary contributions are not batches
 * and have nothing to report here.
 */
export const QA_CHECK_RUN_NAME = "contribution-checker / qa";

/**
 * Publish the QA check for a repo's open batch.
 *
 * Feature-detected and swallowed like its siblings: an installation without
 * `checks:write` gets no check rather than an error, which is the same "fourth
 * state" the decision check has (no check published at all).
 *
 * Gated on `Project.qaCheckEnabled` separately from QA itself. Turning QA on to
 * *see* the state must not silently start failing a required check on a project
 * that never asked to be gated by it.
 */
export async function publishQaCheck(args: {
  installationId: number;
  repoFullName: string;
  batchId: string;
  headSha: string | null;
  project: { id: string; checksEnabled: boolean; qaCheckEnabled: boolean };
  items: QaRenderItem[];
  boardUrl: string;
}): Promise<void> {
  if (!args.project.checksEnabled || !args.project.qaCheckEnabled) return;
  if (!args.headSha) return;
  if (!(await installationHasChecksWrite(args.installationId))) return;

  const payload = buildQaCheckPayload({
    items: args.items,
    boardUrl: args.boardUrl,
  });

  // Reused across verdicts so the release PR accumulates one check that
  // changes, not one per time somebody ticked something off -- but only while
  // the batch head is the commit that run was created against. A check run
  // belongs to its head SHA and PATCH cannot move it, so reusing the id after a
  // push to staging updates a run on a commit nobody is looking at and leaves
  // the new head with no QA check at all, which branch protection reports as a
  // missing required check. Same rule as PrCheck.headSha on the other two.
  const batch = await prisma.stagingBatch.findUnique({
    where: { id: args.batchId },
    select: { qaCheckRunId: true, qaCheckSha: true },
  });
  const existingId =
    batch?.qaCheckRunId && batch.qaCheckSha === args.headSha
      ? batch.qaCheckRunId
      : null;

  const ref = repoRef(args.repoFullName, args.installationId);
  try {
    const newId = await upsertCheckRun(
      ref,
      {
        headSha: args.headSha,
        name: QA_CHECK_RUN_NAME,
        status: payload.status,
        conclusion: payload.conclusion,
        title: payload.title,
        summary: payload.summary,
        detailsUrl: args.boardUrl,
      },
      existingId,
    );
    if (
      newId &&
      (newId !== batch?.qaCheckRunId || batch?.qaCheckSha !== args.headSha)
    ) {
      await prisma.stagingBatch.update({
        where: { id: args.batchId },
        data: { qaCheckRunId: newId, qaCheckSha: args.headSha },
      });
    }
  } catch (e) {
    logger.warn({ err: e, batchId: args.batchId }, "publishQaCheck failed");
  }
}

/**
 * Publish a QA check payload on a commit that has nowhere to store a run id.
 *
 * `publishQaCheck` remembers its run on `StagingBatch` so the release PR
 * accumulates one check that changes. The callers here have no such row: a
 * labelled PR may not even have a `PrCheck` yet, and a merge-queue head SHA is
 * transient and must never overwrite the ids bound to the real batch head. So
 * the run standing on the commit is looked up instead, which costs one call on
 * paths that are rare and keeps repeat deliveries from stacking duplicates
 * under one name.
 */
async function publishStandaloneQaCheck(args: {
  installationId: number;
  repoFullName: string;
  headSha: string | null;
  project: { checksEnabled: boolean; qaCheckEnabled: boolean };
  payload: QaCheckPayload;
  detailsUrl?: string;
}): Promise<void> {
  if (!args.project.checksEnabled || !args.project.qaCheckEnabled) return;
  if (!args.headSha) return;
  if (!(await installationHasChecksWrite(args.installationId))) return;

  const ref = repoRef(args.repoFullName, args.installationId);
  try {
    const existingId = await findCheckRunIdByName(
      ref,
      args.headSha,
      QA_CHECK_RUN_NAME,
    );
    await upsertCheckRun(
      ref,
      {
        headSha: args.headSha,
        name: QA_CHECK_RUN_NAME,
        status: args.payload.status,
        conclusion: args.payload.conclusion,
        title: args.payload.title,
        summary: args.payload.summary,
        ...(args.detailsUrl ? { detailsUrl: args.detailsUrl } : {}),
      },
      existingId,
    );
  } catch (e) {
    logger.warn(
      { err: e, repoFullName: args.repoFullName, headSha: args.headSha },
      "standalone QA check publish failed",
    );
  }
}

/**
 * Publish the QA check as a pass on a commit staging QA has no say over.
 *
 * The counterpart to `publishAggregatePrChecks` in `webhook.ts`, and the same
 * bargain: skipping the thing must not skip the check. A PR carrying
 * `staging:ignore` or `staging:repoint` while based on the default branch will
 * never ship inside a batch, and a merge group that carries no batch is not a
 * release, so `publishQaCheck` (which only ever runs against the aggregate PR's
 * head) will never report on either. Where the check is required on that
 * branch, the PR is blocked on a status nobody is going to send and a merge
 * queue there never drains.
 *
 * Gated exactly like its sibling: `qaCheckEnabled` says whether this project
 * publishes the check at all, and an installation without `checks:write` gets
 * no check rather than an error. Whether QA even applies is decided upstream.
 */
export async function publishQaNotApplicableCheck(args: {
  installationId: number;
  repoFullName: string;
  headSha: string | null;
  project: { id: string; checksEnabled: boolean; qaCheckEnabled: boolean };
  /** Why QA has nothing to report here. Spelled out in the check summary. */
  reason: QaNotApplicableReason;
}): Promise<void> {
  await publishStandaloneQaCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    headSha: args.headSha,
    project: args.project,
    payload: buildQaNotApplicablePayload({ reason: args.reason }),
  });
}

/**
 * Republish the batch's real QA verdict on a commit that is not the batch head.
 *
 * The merge queue's case. GitHub builds a throwaway `gh-readonly-queue/...`
 * commit and requires the check to report against THAT SHA, so a release PR
 * whose batch is fully verified still sits in the queue forever unless the same
 * verdict is published again on the queue's head. It is the same payload
 * `publishQaCheck` builds, on a different commit, and deliberately stores no
 * id: `StagingBatch.qaCheckRunId` and `qaCheckSha` belong to the batch head,
 * and overwriting them with a transient queue SHA would leave the release PR's
 * own check unreachable.
 */
export async function publishQaVerdictCheck(args: {
  installationId: number;
  repoFullName: string;
  headSha: string | null;
  project: { id: string; checksEnabled: boolean; qaCheckEnabled: boolean };
  items: QaRenderItem[];
  boardUrl: string;
}): Promise<void> {
  await publishStandaloneQaCheck({
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    headSha: args.headSha,
    project: args.project,
    payload: buildQaCheckPayload({ items: args.items, boardUrl: args.boardUrl }),
    detailsUrl: args.boardUrl,
  });
}
