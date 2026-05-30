import type { Heuristic } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const diffCohesionHeuristics: Heuristic[] = [
  {
    id: "diff.cross_module",
    group: "diff",
    label: "Cross-module sprawl",
    description: "PR spans more than the configured number of top-level directories.",
    weight: 1,
    defaultEnabled: false,
    defaultThreshold: 4,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 4);
      const tops = new Set<string>();
      for (const f of ctx.files) {
        const top = f.filename.split("/")[0] ?? "";
        if (top) tops.add(top);
      }
      return {
        failed: tops.size > max,
        value: tops.size,
        reason: tops.size > max ? `${tops.size} top-level dirs` : undefined,
      };
    },
  },
  {
    id: "diff.suspicious_renames",
    group: "diff",
    label: "Suspicious renames",
    description: "Many file renames in a single PR: often AI bulk-rename slop.",
    weight: 1,
    defaultEnabled: true,
    defaultThreshold: 10,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 10);
      const renames = ctx.files.filter((f) => f.status === "renamed").length;
      return {
        failed: renames > max,
        value: renames,
        reason: renames > max ? `${renames} renames (>${max})` : undefined,
      };
    },
  },
];
