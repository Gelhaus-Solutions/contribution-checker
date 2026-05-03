/**
 * Public types for the PR quality scoring subsystem.
 *
 * Heuristics are purely computational: given a PrContext, they decide
 * whether they "fire" (i.e. the PR triggered a quality concern). The
 * project's qualityConfig controls which heuristics run and what their
 * thresholds are. Weights are baked into the heuristic definition and
 * are NOT user-editable.
 */

export type HeuristicSeverity = 1 | 2 | 3; // 1=mild, 2=major, 3=critical

export type PrFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  changes: number;
  // The unified diff "@@ ... @@" body — may be undefined for binary or huge files.
  patch?: string | null;
  previous_filename?: string;
};

export type PrCommit = {
  sha: string;
  message: string;
  authorLogin?: string;
  authorEmail?: string;
  committerEmail?: string;
};

export type AccountSnapshot = {
  login: string;
  createdAt?: string; // ISO
  publicRepos?: number;
  followers?: number;
  bio?: string | null;
  email?: string | null;
  hasAvatar?: boolean;
  // Counts gathered via search API; may be undefined if heuristic disabled.
  recentForkCount?: number; // last 24h
  totalPrCount?: number;
  mergedPrCount?: number;
};

export type PrContext = {
  // Project flags relevant to heuristics
  project: {
    id: string;
    qualityConfig: Record<string, HeuristicSetting>;
    prTemplateHoneypots: string[];
  };
  pr: {
    number: number;
    title: string;
    body: string | null;
    headSha: string;
    authorLogin: string;
  };
  files: PrFile[];
  // True when the file list was truncated (e.g. >300 files); some heuristics
  // should treat this as an automatic size signal.
  filesTruncated: boolean;
  commits: PrCommit[];
  account: AccountSnapshot;
};

export type HeuristicSetting = {
  enabled: boolean;
  threshold?: number | string | string[] | Record<string, unknown>;
};

export type HeuristicResult = {
  /** True when the heuristic is concerned about this PR. */
  failed: boolean;
  /** Optional raw measurement (e.g. file count, emoji count) for display. */
  value?: number | string | null;
  /** Optional short human-readable reason. */
  reason?: string;
  /**
   * When this heuristic fires, the final score is capped at this value (0–100).
   * The score formula takes the min over all caps from failed signals. Use
   * sparingly — only for signals that, when true, mean the PR's quality is
   * fundamentally suspect regardless of other passes.
   */
  scoreCap?: number;
};

export type Heuristic = {
  id: string;
  group: "size" | "pr" | "commit" | "code" | "account" | "diff";
  label: string;
  description: string;
  weight: HeuristicSeverity;
  /** Default enabled state when no project config exists. */
  defaultEnabled: boolean;
  /** Default threshold; consumers normalize to the right type. */
  defaultThreshold?: HeuristicSetting["threshold"];
  /**
   * What to render in the settings UI threshold input, if any:
   *  - "number": single integer threshold
   *  - "stringList": comma-separated list
   *  - undefined: no threshold (toggle-only)
   */
  thresholdKind?: "number" | "stringList";
  run(ctx: PrContext, threshold: HeuristicSetting["threshold"]): HeuristicResult;
};

/** Stored per-PR signal map. */
export type SignalsRaw = Record<string, HeuristicResult>;

export type ScoreSummary = {
  /** 0–100 integer, or null when no heuristics are enabled. */
  score: number | null;
  /** ids of heuristics that fired. */
  failedIds: string[];
  /** ids of heuristics that ran but did not fire. */
  passedIds: string[];
  /** Total weight of enabled heuristics that ran. */
  totalWeight: number;
  /** Earned weight (passed). */
  earnedWeight: number;
};
