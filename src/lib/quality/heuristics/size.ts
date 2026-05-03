import type { Heuristic } from "@/lib/quality/types";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const sizeHeuristics: Heuristic[] = [
  {
    id: "size.file_count",
    group: "size",
    label: "Excessive file count",
    description: "Penalize unfocused PRs touching too many files.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: 50,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 50);
      const count = ctx.files.length + (ctx.filesTruncated ? 1 : 0);
      return {
        failed: count > max,
        value: count,
        reason: count > max ? `${count} files (>${max})` : undefined,
      };
    },
  },
  {
    id: "size.line_count",
    group: "size",
    label: "Excessive line count",
    description: "Penalize PRs with very large diffs.",
    weight: 2,
    defaultEnabled: true,
    defaultThreshold: 10000,
    thresholdKind: "number",
    run(ctx, threshold) {
      const max = asNumber(threshold, 10000);
      const lines = ctx.files.reduce(
        (acc, f) => acc + (f.additions ?? 0) + (f.deletions ?? 0),
        0
      );
      return {
        failed: lines > max,
        value: lines,
        reason: lines > max ? `${lines} lines (>${max})` : undefined,
      };
    },
  },
  {
    id: "size.mega_pr",
    group: "size",
    label: "Mega PR (huge diff in a single commit)",
    description:
      "Trips when both file and line counts exceed thresholds AND commit count is 1 — a typical AI-bulk-generation pattern.",
    weight: 3,
    defaultEnabled: true,
    defaultThreshold: 50,
    thresholdKind: "number",
    run(ctx, threshold) {
      const fileMax = asNumber(threshold, 50);
      const lines = ctx.files.reduce(
        (acc, f) => acc + (f.additions ?? 0) + (f.deletions ?? 0),
        0
      );
      const failed =
        ctx.files.length > fileMax && lines > 1000 && ctx.commits.length <= 1;
      return {
        failed,
        value: `${ctx.files.length}f / ${lines}L / ${ctx.commits.length}c`,
        reason: failed ? "Huge diff in one commit" : undefined,
      };
    },
  },
];
