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
  { status: "APPROVED" | "BYPASSED" | "PENDING" | "DENIED" }
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
}): DecisionCheckPayload {
  const { decision, applyUrl, projectName } = args;
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
    case "PENDING":
      return {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "action_required",
        title: "Application required",
        summary: `Open an application for ${projectName} to unblock this PR.`,
        detailsUrl: applyUrl,
      };
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
}): Promise<void> {
  if (!args.project.checksEnabled) return;
  if (!args.headSha) return;
  if (!(await installationHasChecksWrite(args.installationId))) return;

  const payload = buildDecisionCheckPayload({
    decision: args.decision,
    applyUrl: args.applyUrl,
    projectName: args.project.name,
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
