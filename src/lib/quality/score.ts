import type {
  HeuristicSetting,
  ScoreSummary,
  SignalsRaw,
} from "@/lib/quality/types";
import { ALL_HEURISTICS, isHeuristicEnabled } from "@/lib/quality/registry";

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
  const failedIds: string[] = [];
  const passedIds: string[] = [];

  for (const h of ALL_HEURISTICS) {
    if (!isHeuristicEnabled(h, config)) continue;
    const sig = signals[h.id];
    // Heuristics with no recorded signal are treated as not-yet-run and
    // excluded from the average. Re-running quality fills them in.
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
  for (const id of failedIds) {
    const sig = signals[id];
    if (typeof sig?.scoreCap === "number") {
      cap = Math.min(cap, sig.scoreCap);
    }
  }

  const raw = Math.round((earnedWeight / totalWeight) * 100);
  const score = Math.min(raw, cap);
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
