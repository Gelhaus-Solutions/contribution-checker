import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  upsertCheckRun,
  installationHasChecksWrite,
  repoRef,
  type CheckRunStatus,
  type CheckRunConclusion,
} from "@/lib/github/pr-actions";
import type { PrDecision } from "@/lib/applications/decide-pr";

export const CHECK_RUN_NAME = "contribution-checker / decision";

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
 * Map a decision into Check Run state. Pure, no I/O — used by both the
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
      const disabled =
        "bypassReason" in decision && decision.bypassReason === "checker_disabled";
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
          summary: `One or more commits are missing a Developer Certificate of Origin sign-off. Add a "Signed-off-by" trailer to each commit (e.g. \`git commit -s\`) — your PR stays open and we'll re-check automatically.`,
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
          ? `A new version of the ${projectName} CLA must be signed. Sign it to unblock this PR — your PR stays open and we'll re-check automatically once signed.`
          : `Sign the ${projectName} CLA to unblock this PR — your PR stays open and we'll re-check automatically once signed.`,
        detailsUrl: claUrl ?? applyUrl,
      };
    }
    case "DENIED": {
      const cooldownText = decision.cooldownUntil
        ? `Denied until ${decision.cooldownUntil.toISOString().slice(0, 10)}.`
        : "Denied.";
      const reasonText = decision.reason ? ` Reason: ${decision.reason}` : "";
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "failure",
        title: cooldownText,
        summary: `${cooldownText}${reasonText}`,
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
      existingId
    );
    if (newId && args.prCheckId) {
      await prisma.prCheck.update({
        where: { id: args.prCheckId },
        data: { checkRunId: newId, headSha: args.headSha },
      });
    }
  } catch (e) {
    logger.warn({ err: e, prCheckId: args.prCheckId }, "publishDecisionCheck failed");
  }
}
