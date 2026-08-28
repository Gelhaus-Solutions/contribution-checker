/**
 * Public types for the PR quality scoring subsystem.
 *
 * Heuristics are purely computational: given a PrContext, they decide
 * whether they "fire" (i.e. the PR triggered a quality concern). The
 * project's qualityConfig controls which heuristics run and what their
 * thresholds are. Weights are baked into the heuristic definition and
 * are NOT user-editable.
 */

export type HeuristicSeverity = 1 | 2 | 3 | 4; // 1=mild, 2=major, 3=critical, 4=blocker

export type PrFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  changes: number;
  // The unified diff "@@ ... @@" body; may be undefined for binary or huge files.
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
    /**
     * Strictness (0–100) for `pr.uses_template` checkbox matching. 100 means
     * exact substring; lower values tolerate typos and edits via token-overlap.
     */
    templateMatchPct: number;
  };
  pr: {
    number: number;
    title: string;
    body: string | null;
    headSha: string;
    authorLogin: string;
  };
  /**
   * Raw contents of the repo's PR template (e.g.
   * `.github/PULL_REQUEST_TEMPLATE.md`). Null when the repo has none, or
   * when the template was not fetched (e.g. CI mode without a workflow
   * update). Heuristics that need it must treat null as "not applicable".
   */
  prTemplate: string | null;
  files: PrFile[];
  // True when the file list was truncated (e.g. >300 files); some heuristics
  // should treat this as an automatic size signal.
  filesTruncated: boolean;
  commits: PrCommit[];
  account: AccountSnapshot;
  /**
   * A stored model assessment of this PR, or null when none has been run.
   *
   * Fetched from the database before the run loop and attached here, exactly as
   * `account` and `prTemplate` are. That is what lets an AI-informed heuristic
   * exist without a heuristic ever performing I/O: `run()` reads a value that is
   * already in hand, so scoring stays pure and reproducible.
   *
   * Null is the normal case. AI runs are manual by default, so most PRs never
   * have one, and a heuristic reading this must return null rather than fire.
   */
  ai?: AiVerdict | null;
};

/**
 * A model's view of one PR. Deliberately narrow: a score and a sentence.
 * Anything richer belongs on the dashboard, not in the scoring path.
 */
export type AiVerdict = {
  /** 0-100. Higher is better, matching the direction of the overall score. */
  assessment: number;
  reason: string;
  modelId: string;
  computedAt: string;
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
   * sparingly, only for signals that, when true, mean the PR's quality is
   * fundamentally suspect regardless of other passes.
   */
  scoreCap?: number;
  /**
   * Override the default `weight * PENALTY_PER_WEIGHT` deduction with a
   * heuristic-computed value (in score points, 0–100). Use when the penalty
   * should scale with the measured value (e.g. per violating commit, per
   * excess reference). Ignored for w4 heuristics, which use the cap model.
   */
  penaltyPoints?: number;
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
  /**
   * Evaluate the PR.
   *
   * Returning `null` means "no signal", which is different from passing. It is
   * for a heuristic whose input is genuinely absent: no AI run has happened, so
   * there is nothing to judge. `computeScore` already excludes heuristics with
   * no recorded signal, so a null is simply not stored and the PR scores exactly
   * as it would if the heuristic did not exist. Returning `{failed: false}`
   * instead would silently award weight the PR never earned.
   *
   * Must stay a pure function of `ctx`. No network, no database: the score is
   * recomputed on every read, so a heuristic that reached outside its context
   * would make the same PR score differently on two consecutive page loads.
   */
  run(
    ctx: PrContext,
    threshold: HeuristicSetting["threshold"]
  ): HeuristicResult | null;
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
