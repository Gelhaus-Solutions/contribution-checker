import type { Heuristic, HeuristicSetting } from "@/lib/quality/types";
import { sizeHeuristics } from "@/lib/quality/heuristics/size";
import { prTextHeuristics } from "@/lib/quality/heuristics/prText";
import { commitHeuristics } from "@/lib/quality/heuristics/commits";
import { codeHeuristics } from "@/lib/quality/heuristics/code";
import { accountHeuristics } from "@/lib/quality/heuristics/account";
import { diffCohesionHeuristics } from "@/lib/quality/heuristics/diffCohesion";

export const ALL_HEURISTICS: Heuristic[] = [
  ...sizeHeuristics,
  ...prTextHeuristics,
  ...commitHeuristics,
  ...codeHeuristics,
  ...accountHeuristics,
  ...diffCohesionHeuristics,
];

export const HEURISTIC_BY_ID = new Map<string, Heuristic>(
  ALL_HEURISTICS.map((h) => [h.id, h])
);

/**
 * Read a project's qualityConfig and decide whether a heuristic is enabled.
 * Falls back to the heuristic's `defaultEnabled` when the config is missing.
 */
export function isHeuristicEnabled(
  h: Heuristic,
  config: Record<string, HeuristicSetting>
): boolean {
  const setting = config[h.id];
  if (!setting) return h.defaultEnabled;
  return setting.enabled !== false;
}

/**
 * Effective threshold for a heuristic given a project's config.
 */
export function thresholdFor(
  h: Heuristic,
  config: Record<string, HeuristicSetting>
): HeuristicSetting["threshold"] {
  const setting = config[h.id];
  if (setting && setting.threshold !== undefined) return setting.threshold;
  return h.defaultThreshold;
}

/**
 * Parse a Project.qualityConfig JSON string into a typed map. Tolerates
 * malformed JSON by returning an empty map.
 */
export function parseQualityConfig(
  raw: string | null | undefined
): Record<string, HeuristicSetting> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, HeuristicSetting>;
    }
  } catch {
    // fall through
  }
  return {};
}

export function parseHoneypots(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string");
  } catch {
    // ignore
  }
  return [];
}
