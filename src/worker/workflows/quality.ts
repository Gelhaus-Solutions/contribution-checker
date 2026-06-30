import { acts } from "./proxies";
import type {
  QualityBackfillInput,
  QualityBackfillResult,
} from "../../lib/temporal/contracts";

/** How many PRs to score concurrently. Bounded so backfill never slams the
 * GitHub API (the legacy loop ran strictly serial; this is a gentle speedup). */
const CONCURRENCY = 4;

/**
 * Re-score a project's PRs durably. Replaces the synchronous 200-row loop that
 * ran inside a server action (and timed out on large projects). Each PR is a
 * separately-retried activity; the pool keeps GitHub API pressure bounded.
 */
export async function qualityBackfill(
  input: QualityBackfillInput
): Promise<QualityBackfillResult> {
  const targets = await acts.loadBackfillTargets(input.projectId, input.limit);
  await acts.recordBackfillAudit({
    projectId: input.projectId,
    actorId: input.triggeredById,
    phase: "started",
    count: targets.length,
  });

  let next = 0;
  let scored = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (next < targets.length) {
      const target = targets[next++];
      try {
        if (await acts.scorePrCheckForBackfill(target)) scored += 1;
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker())
  );

  await acts.recordBackfillAudit({
    projectId: input.projectId,
    actorId: input.triggeredById,
    phase: "completed",
    count: targets.length,
    scored,
  });

  return { scored, failed };
}
