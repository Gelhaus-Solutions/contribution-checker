import type {
  HeuristicSetting,
  ScoreSummary,
  SignalsRaw,
} from "@/lib/quality/types";
import { ALL_HEURISTICS, HEURISTIC_BY_ID, isHeuristicEnabled } from "@/lib/quality/registry";

/**
 * Hard score caps applied when weight-4 ("blocker") heuristics fire. w4 is
 * reserved for signals that are essentially proof of slop (AI watermark
 * phrases, honeypot copy-paste, ignored PR template) — a clean record on
 * the other heuristics shouldn't rescue the PR. The cap tightens with each
 * additional w4 fire; 3+ floors the ceiling at 20. Lower-weight failures
 * deduct further from this ceiling.
 */
const W4_SCORE_CAPS = [50, 35, 20] as const;

/**
 * Points deducted per unit of weight when a non-w4 heuristic fails.
 * Every heuristic is a *negative detector* (failing = bad signal found),
 * so passing is the boring default. Scoring on "what % of detectors
 * stayed quiet" rewarded any PR that didn't happen to trip the few
 * patterns we look for. Instead, start at 100 and subtract per failure
 * so the score reflects how many real issues the PR has, not how many
 * dormant detectors it avoided.
 *
 * With PENALTY_PER_WEIGHT=10:
 *   w1 fail → -10, w2 fail → -20, w3 fail → -30
 */
const PENALTY_PER_WEIGHT = 10;

function w4Cap(failedW4Count: number): number {
  if (failedW4Count <= 0) return 100;
  const idx = Math.min(failedW4Count, W4_SCORE_CAPS.length) - 1;
  return W4_SCORE_CAPS[idx];
}

/**
 * Compute the 0–100 score from raw signals + the project's *current*
 * qualityConfig. Pure: no I/O. Used everywhere the score is read so a
 * config change applies instantly without any recompute job.
 *
 * Model: start at a ceiling (100, lowered by w4 caps and per-signal
 * scoreCaps), then subtract `weight * PENALTY_PER_WEIGHT` for each
 * failed non-w4 heuristic. Floor at 0.
 */
export function computeScore(
  signals: SignalsRaw,
  config: Record<string, HeuristicSetting>
): ScoreSummary {
  let totalWeight = 0;
  let earnedWeight = 0;
  const failedIds: string[] = [];
  const passedIds: string[] = [];

  for (const h of ALL_HEURISTICS) {
    if (!isHeuristicEnabled(h, config)) continue;
    const sig = signals[h.id];
    // Heuristics with no recorded signal are treated as not-yet-run and
    // excluded. Re-running quality fills them in.
    if (!sig) continue;
    totalWeight += h.weight;
    if (sig.failed) {
      failedIds.push(h.id);
    } else {
      earnedWeight += h.weight;
      passedIds.push(h.id);
    }
  }

  if (totalWeight === 0) {
    return { score: null, failedIds, passedIds, totalWeight, earnedWeight };
  }

  let cap = 100;
  let failedW4 = 0;
  let deductions = 0;
  for (const id of failedIds) {
    const sig = signals[id];
    if (typeof sig?.scoreCap === "number") {
      cap = Math.min(cap, sig.scoreCap);
    }
    const h = HEURISTIC_BY_ID.get(id);
    if (!h) continue;
    if (h.weight >= 4) {
      failedW4 += 1;
    } else {
      const override = sig?.penaltyPoints;
      const penalty =
        typeof override === "number" && Number.isFinite(override) && override >= 0
          ? override
          : h.weight * PENALTY_PER_WEIGHT;
      deductions += penalty;
    }
  }

  const ceiling = Math.min(cap, w4Cap(failedW4));
  const score = Math.max(0, ceiling - deductions);
  return { score, failedIds, passedIds, totalWeight, earnedWeight };
}

export function parseSignalsRaw(raw: string | null | undefined): SignalsRaw {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SignalsRaw;
    }
  } catch {
    // ignore
  }
  return {};
}
