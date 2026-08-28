import type { AiTaskSetting } from "@/lib/ai/types";

/**
 * Per-project AI settings, stored as a JSON string in `Project.aiConfig`.
 *
 * Same contract as `parseQualityConfig` in src/lib/quality/registry.ts and
 * `parseDigestSections` in src/lib/github/staging-digest.ts: tolerant, never
 * throws, and never a bare `JSON.parse` at the call site. An unreadable column
 * degrades to "no overrides", which means every task falls back to its own
 * `defaultEnabled` (all false), so a corrupt value cannot switch a feature on.
 */
export function parseAiConfig(
  raw: string | null | undefined
): Record<string, AiTaskSetting> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AiTaskSetting> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const enabled = (v as Record<string, unknown>).enabled;
      if (typeof enabled === "boolean") out[k] = { enabled };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Serialize with sorted keys.
 *
 * Deterministic on purpose: the settings action diffs the before and after
 * values to decide what to write into the audit payload, and an unstable key
 * order would make every save look like a change.
 */
export function serializeAiConfig(config: Record<string, AiTaskSetting>): string {
  const sorted: Record<string, AiTaskSetting> = {};
  for (const k of Object.keys(config).sort()) sorted[k] = config[k];
  return JSON.stringify(sorted);
}
