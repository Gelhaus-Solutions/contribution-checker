import type {
  HeuristicSetting,
  ScoreSummary,
  SignalsRaw,
} from "@/lib/quality/types";
import { ALL_HEURISTICS, HEURISTIC_BY_ID, isHeuristicEnabled } from "@/lib/quality/registry";

/**
 * Hard score caps applied when weight-4 ("blocker") heuristics fire. w4 is
 * reserved for signals that are essentially proof of slop (AI watermark
 * phrases, honeypot copy-paste, ignored PR template) — a passing average
 * over the other heuristics shouldn't rescue the PR. The cap tightens with
 * each additional w4 fire; 3+ floors the score at 20.
 */
const W4_SCORE_CAPS = [50, 35, 20] as const;

function w4Cap(failedW4Count: number): number {
  if (failedW4Count <= 0) return 100;
  const idx = Math.min(failedW4Count, W4_SCORE_CAPS.length) - 1;
  return W4_SCORE_CAPS[idx];
}

/**
 * Compute the 0–100 score from raw signals + the project's *current*
 * qualityConfig. Pure: no I/O. Used everywhere the score is read so a
 * config change applies instantly without any recompute job.
 */
export function computeScore(
  signals: SignalsRaw,
  config: Record<string, HeuristicSetting>
): ScoreSummary {
  let totalWeight = 0;
  let earnedWeight = 0;
  let totalNonW4Weight = 0;
  let earnedNonW4Weight = 0;
  const failedIds: string[] = [];
  const passedIds: string[] = [];

  for (const h of ALL_HEURISTICS) {
    if (!isHeuristicEnabled(h, config)) continue;
    const sig = signals[h.id];
    // Heuristics with no recorded signal are treated as not-yet-run and
    // excluded from the average. Re-running quality fills them in.
    if (!sig) continue;
    totalWeight += h.weight;
    const isW4 = h.weight >= 4;
    if (!isW4) totalNonW4Weight += h.weight;
    if (sig.failed) {
      failedIds.push(h.id);
    } else {
      earnedWeight += h.weight;
      if (!isW4) earnedNonW4Weight += h.weight;
      passedIds.push(h.id);
    }
  }

  if (totalWeight === 0) {
    return { score: null, failedIds, passedIds, totalWeight, earnedWeight };
  }

  let cap = 100;
  let failedW4 = 0;
  for (const id of failedIds) {
    const sig = signals[id];
    if (typeof sig?.scoreCap === "number") {
      cap = Math.min(cap, sig.scoreCap);
    }
    const h = HEURISTIC_BY_ID.get(id);
    if (h && h.weight >= 4) failedW4 += 1;
  }

  const raw = Math.round((earnedWeight / totalWeight) * 100);
  let score = Math.min(raw, cap);
  // w4 caps OVERRIDE the raw average — a single blocker drops the score to
  // its tier ceiling. From that ceiling, the lower-weight (w1–w3) heuristics
  // further reduce the score: passing all of them keeps the score at the
  // cap, failing them all pulls it toward 0. The raw average is discarded
  // here (it would double-penalize, since the failed w4s already drag it
  // down). Per-signal `scoreCap` still applies if it's tighter.
  if (failedW4 > 0) {
    const ceiling = Math.min(cap, w4Cap(failedW4));
    const passRate =
      totalNonW4Weight > 0 ? earnedNonW4Weight / totalNonW4Weight : 1;
    score = Math.round(ceiling * passRate);
  }
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
