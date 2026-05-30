import type { PrDecision } from "@/lib/applications/decide-pr";

/**
 * The CLA heads-up appended to a pending PR comment when the project requires a
 * CLA the author hasn't signed. Exported so the retroactive backfill can append
 * the same copy to comments already on GitHub, keeping the wording in one place.
 */
export function claPendingReminderNote(claUrl: string): string {
  return (
    `\n\nThis project also requires a signed Contributor License Agreement. ` +
    `You can sign it now at ${claUrl} so you're ready as soon as your ` +
    `application is approved.`
  );
}

/**
 * Build the PR-comment body for PENDING/DENIED/CHECK_REQUIRED decisions.
 * Returns null when the decision is APPROVED, BYPASSED, or IGNORED (no
 * comment needed).
 *
 * PENDING/DENIED comments accompany a PR *close*; CHECK_REQUIRED comments
 * accompany a non-closing CLA/DCO gate that keeps the PR open and fails a
 * Check.
 *
 * Used by both the GitHub App webhook and the CI mode endpoint to keep
 * the user-facing copy in one place.
 *
 * `claUrl` is the standalone signing page (callers pass `${applyUrl}/cla`);
 * it defaults to `${applyUrl}/cla` when omitted.
 */
export function buildDecisionMessage(args: {
  decision: PrDecision;
  projectName: string;
  applyUrl: string;
  ghLogin: string;
  claUrl?: string;
  /**
   * When true, the PENDING message also tells the contributor they'll need to
   * sign the CLA (approval is blocked until both the application is approved and
   * the CLA is signed), so it's surfaced on GitHub up front.
   */
  needsCla?: boolean;
}): string | null {
  const { decision, projectName, applyUrl, ghLogin } = args;
  const claUrl = args.claUrl ?? `${applyUrl}/cla`;
  if (decision.status === "PENDING") {
    const base =
      decision.reason === "submitted"
        ? `Hi @${ghLogin}! Your application for **${projectName}** is awaiting review. ` +
          `We'll reopen this PR once it's approved. Status: ${applyUrl}`
        : // "no-application" or "cooldown-elapsed" → invite the user to apply.
          `Hi @${ghLogin}! Thanks for the PR. ` +
          `Contributions to **${projectName}** are gated behind an application. ` +
          `Please apply at ${applyUrl} and we'll reopen this PR once you're approved.`;
    return args.needsCla ? base + claPendingReminderNote(claUrl) : base;
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
  if (decision.status === "CHECK_REQUIRED") {
    if (decision.reason === "cla_required") {
      return (
        `Hi @${ghLogin}! Before we can accept contributions to **${projectName}** ` +
        `you need to sign the Contributor License Agreement. ` +
        `Sign here: ${claUrl}. Your PR stays open and we'll re-check ` +
        `automatically once signed.`
      );
    }
    if (decision.reason === "cla_stale") {
      return (
        `Hi @${ghLogin}! The Contributor License Agreement for ` +
        `**${projectName}** was updated, so we need you to re-sign the ` +
        `current version before we can accept your contributions. ` +
        `Re-sign here: ${claUrl}. Your PR stays open and we'll re-check ` +
        `automatically once signed.`
      );
    }
    // "dco_missing": no external URL; explain the Signed-off-by trailer.
    return (
      `Hi @${ghLogin}! Contributions to **${projectName}** require a ` +
      `Developer Certificate of Origin sign-off: every commit needs a ` +
      "`Signed-off-by: Your Name <you@example.com>` trailer in its message. " +
      "Add it by amending your latest commit with `git commit -s --amend`, " +
      "or sign off the whole branch with `git rebase --signoff` (then " +
      "force-push). Your PR stays open and we'll re-check automatically " +
      "once the sign-off is present."
    );
  }
  return null;
}
