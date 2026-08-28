import type { Heuristic } from "@/lib/quality/types";

/**
 * The AI-informed quality signal.
 *
 * This heuristic performs no I/O and calls no model. It reads `ctx.ai`, a
 * verdict fetched from the database before the run loop and attached to the
 * context exactly as `account` and `prTemplate` are. Scoring therefore stays
 * pure and reproducible: the same context always yields the same result, which
 * matters because `computeScore` recomputes on every page read.
 *
 * Absent is not failing. AI runs are manual by default, so most PRs will never
 * carry a verdict, and `run` returns null for those. A null is not stored, so
 * `computeScore` leaves this heuristic out of the weight total entirely and the
 * PR scores exactly as it would if the heuristic did not exist. Returning
 * `{failed: false}` instead would hand every un-analysed PR free credit, which
 * is worse than the penalty it is trying to avoid.
 *
 * Weight 2 rather than 4. A weight-4 heuristic caps the whole score, and this is
 * a model's opinion formed without seeing the diff: it is a useful nudge, not
 * proof of anything, and it should never be the reason a contribution is
 * treated as slop.
 */
export const aiHeuristics: Heuristic[] = [
  {
    id: "pr.ai_assessment",
    group: "pr",
    label: "AI description assessment",
    description:
      "Fires when a model judges the PR's description to be a poor guide to what the change actually does. Only applies to PRs where the AI assessment task has been run; PRs without one are unaffected.",
    weight: 2,
    defaultEnabled: false,
    defaultThreshold: 40,
    thresholdKind: "number",
    run(ctx, threshold) {
      const verdict = ctx.ai;
      // No run, no opinion. See the note above: this is the common case.
      if (!verdict) return null;

      const limit =
        typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 40;
      const score = verdict.assessment;

      return {
        failed: score < limit,
        value: score,
        reason:
          score < limit
            ? `Model rated the description ${score}/100: ${verdict.reason}`
            : undefined,
      };
    },
  },
];
