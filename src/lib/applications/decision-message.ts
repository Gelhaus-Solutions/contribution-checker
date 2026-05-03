import type { PrDecision } from "@/lib/applications/decide-pr";

/**
 * Build the close-comment body for PENDING/DENIED decisions. Returns null
 * when the decision is APPROVED or BYPASSED (no comment needed).
 *
 * Used by both the GitHub App webhook and the CI mode endpoint to keep
 * the user-facing copy in one place.
 */
export function buildDecisionMessage(args: {
  decision: PrDecision;
  projectName: string;
  applyUrl: string;
  ghLogin: string;
}): string | null {
  const { decision, projectName, applyUrl, ghLogin } = args;
  if (decision.status === "PENDING") {
    if (decision.reason === "submitted") {
      return (
        `Hi @${ghLogin}! Your application for **${projectName}** is awaiting review. ` +
        `We'll reopen this PR once it's approved. Status: ${applyUrl}`
      );
    }
    // "no-application" or "cooldown-elapsed" → invite the user to apply.
    return (
      `Hi @${ghLogin}! Thanks for the PR. ` +
      `Contributions to **${projectName}** are gated behind a short application. ` +
      `Please apply at ${applyUrl} and we'll reopen this PR once you're approved.`
    );
  }
  if (decision.status === "DENIED") {
    const reasonPart = decision.reason ? `: ${decision.reason}` : "";
    const tail = decision.cooldownUntil
      ? `You may re-apply on ${decision.cooldownUntil.toISOString().slice(0, 10)}.`
      : `Please contact a project admin if you believe this is in error.`;
    return (
      `Hi @${ghLogin}, your application for **${projectName}** was previously declined` +
      reasonPart +
      `. ` +
      tail
    );
  }
  return null;
}
